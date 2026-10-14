# Thread-pool sizing ONLY (ruling 124 packing): the IndicConformer remote code creates one onnxruntime session per language component with the
# default pool (one thread per machine core, spinning), i.e. ~660 threads per process, which thrashes when several stacks share a node.
# This gives every session an explicit intra-op thread count and disables spin-waiting. Model, weights, code files and decoding are untouched.
import os
try:
    import onnxruntime as ort
    _T = int(os.environ.get("ORT_INTRA_THREADS", "0"))
    if _T > 0:
        _orig = ort.InferenceSession.__init__
        def _init(self, path_or_bytes, sess_options=None, providers=None, provider_options=None, **kw):
            if sess_options is None:
                sess_options = ort.SessionOptions()
            sess_options.intra_op_num_threads = _T
            sess_options.inter_op_num_threads = 1
            sess_options.add_session_config_entry("session.intra_op.allow_spinning", "0")
            return _orig(self, path_or_bytes, sess_options, providers, provider_options, **kw)
        ort.InferenceSession.__init__ = _init
except Exception:
    pass
