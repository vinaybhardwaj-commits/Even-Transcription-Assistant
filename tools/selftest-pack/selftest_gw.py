"""Sarvam TTS through the Even AWS gateway, stdlib + the `openssl` CLI only. Port of lib/sarvam-gateway.ts (same chain, same signing).

Chain: SA key file -> Google access token (JWT bearer) -> IAM generateIdToken ON THE SA ITSELF (aud = SARVAM_GW_AUDIENCE, includeEmail)
-> STS AssumeRoleWithWebIdentity (SARVAM_GW_ROLE_ARN, SARVAM_GW_REGION) -> SigV4 execute-api -> SARVAM_GW_BASE_URL + /text-to-speech.

ENV (names only; no value is ever printed, logged or stored): SARVAM_SA_KEY_PATH, SARVAM_GW_AUDIENCE, SARVAM_GW_ROLE_ARN, SARVAM_GW_BASE_URL, SARVAM_GW_REGION.
Errors carry a code and an HTTP status, never a response body, a token or a URL.
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ENV_NAMES = ("SARVAM_SA_KEY_PATH", "SARVAM_GW_AUDIENCE", "SARVAM_GW_ROLE_ARN", "SARVAM_GW_BASE_URL", "SARVAM_GW_REGION")
TIMEOUT_S = 30


class GatewayError(Exception):
    def __init__(self, code, status=None, transient=False):
        super().__init__(code if status is None else f"{code}: {status}")
        self.code, self.status, self.transient = code, status, transient


def missing_env(environ=None):
    environ = os.environ if environ is None else environ
    return [n for n in ENV_NAMES if not (environ.get(n) or "").strip()]


def _env(name):
    v = (os.environ.get(name) or "").strip()
    if not v:
        raise GatewayError("not_configured", None)
    return v


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _post(url, data, headers, code):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        e.read()  # drained, never quoted
        raise GatewayError(code, e.code, e.code == 429 or e.code >= 500)
    except Exception:
        raise GatewayError(code + "_network", None, True)


def rs256_sign(data: bytes, private_key_pem: str) -> bytes:
    """RSA-SHA256 with the openssl CLI; the key goes through a 0600 temp file that is removed at once."""
    import tempfile
    fd, path = tempfile.mkstemp(prefix="k", suffix=".pem")
    try:
        os.chmod(path, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(private_key_pem)
        p = subprocess.run(["openssl", "dgst", "-sha256", "-sign", path], input=data, capture_output=True)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if p.returncode != 0 or not p.stdout:
        raise GatewayError("key_invalid", None)
    return p.stdout


def google_access_token(sa, now):
    token_uri = sa.get("token_uri") or "https://oauth2.googleapis.com/token"
    iat = int(now)
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(json.dumps({"iss": sa["client_email"], "scope": "https://www.googleapis.com/auth/cloud-platform", "aud": token_uri, "iat": iat, "exp": iat + 3600}).encode())
    sig = b64url(rs256_sign(f"{header}.{claims}".encode(), sa["private_key"]))
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": f"{header}.{claims}.{sig}"}).encode()
    _, raw = _post(token_uri, body, {"Content-Type": "application/x-www-form-urlencoded"}, "google_token")
    tok = json.loads(raw or b"{}").get("access_token")
    if not tok:
        raise GatewayError("google_token_empty")
    return tok


def google_id_token(sa, access):
    url = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/%s:generateIdToken" % urllib.parse.quote(sa["client_email"], safe="")
    body = json.dumps({"audience": _env("SARVAM_GW_AUDIENCE"), "includeEmail": True}).encode()
    _, raw = _post(url, body, {"Content-Type": "application/json", "Authorization": "Bearer " + access}, "id_token")
    tok = json.loads(raw or b"{}").get("token")
    if not tok:
        raise GatewayError("id_token_empty")
    return tok


def sts_assume(id_token):
    region = _env("SARVAM_GW_REGION")
    body = urllib.parse.urlencode({"Action": "AssumeRoleWithWebIdentity", "Version": "2011-06-15", "RoleArn": _env("SARVAM_GW_ROLE_ARN"),
                                   "RoleSessionName": "selftest-pack", "WebIdentityToken": id_token, "DurationSeconds": "3600"}).encode()
    _, raw = _post(f"https://sts.{region}.amazonaws.com/", body, {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, "sts")
    try:
        c = json.loads(raw)["AssumeRoleWithWebIdentityResponse"]["AssumeRoleWithWebIdentityResult"]["Credentials"]
        return {"ak": c["AccessKeyId"], "sk": c["SecretAccessKey"], "st": c["SessionToken"]}
    except Exception:
        raise GatewayError("sts_no_credentials")


def _rfc3986(s):
    return urllib.parse.quote(s, safe="-_.~")


def sign_sigv4(method, url, headers, body: bytes, region, service, creds, now=None):
    """SigV4 for execute-api: signed headers host, x-amz-date, x-amz-security-token, content-type (same as lib/sarvam-gateway.ts signSigV4)."""
    u = urllib.parse.urlsplit(url)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz = now.strftime("%Y%m%dT%H%M%SZ")
    stamp = amz[:8]
    to_sign = {"host": u.netloc, "x-amz-date": amz, "x-amz-security-token": creds["st"]}
    for k, v in headers.items():
        if k.lower() == "content-type":
            to_sign["content-type"] = " ".join(v.split())
    names = sorted(to_sign)
    canon_headers = "".join(f"{n}:{to_sign[n]}\n" for n in names)
    signed = ";".join(names)
    path = "/".join(_rfc3986(_rfc3986(urllib.parse.unquote(s))) for s in u.path.split("/")) or "/"
    query = "&".join(f"{k}={v}" for k, v in sorted((_rfc3986(k), _rfc3986(v)) for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True)))
    creq = "\n".join([method.upper(), path, query, canon_headers, signed, hashlib.sha256(body).hexdigest()])
    scope = f"{stamp}/{region}/{service}/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(creq.encode()).hexdigest()])
    h = lambda k, m: hmac.new(k, m.encode(), hashlib.sha256).digest()
    k = h(h(h(h(("AWS4" + creds["sk"]).encode(), stamp), region), service), "aws4_request")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    out = dict(headers)
    out["x-amz-date"] = amz
    out["x-amz-security-token"] = creds["st"]
    out["Authorization"] = f"AWS4-HMAC-SHA256 Credential={creds['ak']}/{scope}, SignedHeaders={signed}, Signature={sig}"
    return out


class GatewayTTS:
    """Callable `tts(text, lang, speaker, model, pace) -> (wav_bytes, request_id, http_status)`; raises GatewayError."""

    def __init__(self):
        self._creds = None
        self._exp = 0.0

    def _credentials(self):
        if self._creds and time.time() < self._exp - 300:
            return self._creds
        with open(_env("SARVAM_SA_KEY_PATH"), "r") as f:
            sa = json.load(f)
        now = time.time()
        self._creds = sts_assume(google_id_token(sa, google_access_token(sa, now)))
        self._exp = now + 3600
        return self._creds

    def __call__(self, text, lang, speaker, model="bulbul:v3", pace=1.0):
        base = _env("SARVAM_GW_BASE_URL").rstrip("/")
        url = base + "/text-to-speech"
        body = json.dumps({"text": text, "target_language_code": lang, "speaker": speaker, "model": model, "pace": pace, "speech_sample_rate": 24000}, ensure_ascii=False).encode()
        headers = sign_sigv4("POST", url, {"Content-Type": "application/json"}, body, _env("SARVAM_GW_REGION"), "execute-api", self._credentials())
        status, raw = _post(url, body, headers, "tts")
        try:
            j = json.loads(raw)
            wav = base64.b64decode(j["audios"][0])
        except Exception:
            raise GatewayError("tts_bad_response", status)
        rid = j.get("request_id") if isinstance(j.get("request_id"), str) else None
        return wav, rid, status
