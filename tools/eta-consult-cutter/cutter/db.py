"""One place that opens the database: READ-ONLY enforced at connect time (R2). The credential is read from a file and never printed or logged."""
from . import config as C

def connect(url_file=None, **kw):
    """psycopg connection with default_transaction_read_only=on set as a startup option (so even the first transaction is read-only) and conn.read_only = True."""
    import psycopg
    c = psycopg.connect(open(url_file or C.DB_URL_FILE).read().strip(), connect_timeout=20, options="-c default_transaction_read_only=on", **kw)
    c.read_only = True
    return c
