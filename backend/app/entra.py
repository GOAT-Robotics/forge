"""Microsoft Entra ID (Azure AD) sign-in: OpenID Connect authorization-code flow with PKCE.

Configuration (same names as Volt):
  AUTH_MICROSOFT_ENTRA_ID_ID       application (client) id
  AUTH_MICROSOFT_ENTRA_ID_SECRET   client secret
  AUTH_MICROSOFT_ENTRA_ID_ISSUER   https://login.microsoftonline.com/<tenant-id>/v2.0/
  AUTH_MICROSOFT_ENTRA_ID_TENANT   optional, tenant id when the issuer does not name one
  ALLOWED_EMAIL_DOMAINS            comma separated, default goat-robotics.com
  ADMIN_EMAILS                     comma separated, these users become administrators
  DEFAULT_ROLE                     role for first sign-in of other domain users (default viewer)
  PUBLIC_URL                       external base URL, e.g. https://forge.goat-robotics.com

Only single-tenant tokens from the configured tenant, for members (no guests) whose e-mail is in an allowed
domain, create a session. The Entra object id (oid) is the identity; the e-mail only links a pre-created
account that has no oid yet.
"""
import os, re, json, time, base64, hashlib, secrets, datetime
from urllib.parse import urlencode, urlsplit
import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse
from . import db
from .security import token_hash, sign, verify

router = APIRouter()
CLIENT_ID = lambda: os.getenv('AUTH_MICROSOFT_ENTRA_ID_ID', '').strip()
CLIENT_SECRET = lambda: os.getenv('AUTH_MICROSOFT_ENTRA_ID_SECRET', '').strip()


def enabled():
    return bool(CLIENT_ID() and CLIENT_SECRET() and tenant())


def tenant():
    t = os.getenv('AUTH_MICROSOFT_ENTRA_ID_TENANT', '').strip().lower()
    if t:
        return t
    m = re.search(r'login\.microsoftonline\.com/([0-9a-f-]{36})/', os.getenv('AUTH_MICROSOFT_ENTRA_ID_ISSUER', ''), re.I)
    return m.group(1).lower() if m else ''


def allowed_domains():
    raw = os.getenv('ALLOWED_EMAIL_DOMAINS', 'goat-robotics.com')
    return [d.strip().lower().lstrip('@') for d in raw.split(',') if d.strip()]


def domain_ok(email):
    domains = allowed_domains()
    return bool(email) and '@' in email and (not domains or email.lower().rsplit('@', 1)[1] in domains)


def local_login_allowed():
    """Password sign-in is for development/bootstrap only once Entra is configured."""
    return not enabled() or os.getenv('FORGE_ALLOW_LOCAL_LOGIN', 'false') == 'true'


def admin_emails():
    return [e.strip().lower() for e in os.getenv('ADMIN_EMAILS', '').split(',') if e.strip()]


def public_url(request):
    primary = (os.getenv('PUBLIC_URL') or str(request.base_url)).rstrip('/')
    host = request.headers.get('host', '').lower()
    for url in [primary, *os.getenv('PUBLIC_URLS', '').split(',')]:
        url = url.strip().rstrip('/')
        if url and urlsplit(url).netloc.lower() == host:
            return url
    return primary


def redirect_uri(request):
    return public_url(request) + '/api/auth/entra/callback'


def safe_next(n):
    return n if isinstance(n, str) and n.startswith('/') and not n.startswith('//') and '\\' not in n else '/'


def start_session(user_id):
    token = secrets.token_urlsafe(40)
    expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=12)).isoformat()
    with db.connect() as c:
        c.execute('INSERT INTO sessions VALUES(?,?,?)', (token_hash(token), user_id, expires))
        c.execute('UPDATE users SET last_login=? WHERE id=?', (db.now(), user_id))
    return token


def set_session_cookie(resp, token, request):
    secure = os.getenv('COOKIE_SECURE', 'false') == 'true' or public_url(request).startswith('https://')
    resp.set_cookie('forge_session', token, httponly=True, samesite='lax', secure=secure, max_age=43200, path='/')


@router.get('/api/auth/entra/login')
def login(request: Request, next: str = '/'):
    if not enabled():
        raise HTTPException(404, 'Microsoft sign-in is not configured')
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    payload = json.dumps({'s': state, 'n': nonce, 'v': verifier, 'next': safe_next(next)}, separators=(',', ':'))
    exp, mac = sign('oidc:' + payload, ttl=600)
    domains = allowed_domains()
    q = {'client_id': CLIENT_ID(), 'response_type': 'code', 'redirect_uri': redirect_uri(request), 'response_mode': 'query',
         'scope': 'openid profile email', 'state': state, 'nonce': nonce, 'code_challenge': challenge, 'code_challenge_method': 'S256',
         'prompt': 'select_account'}
    if len(domains) == 1:
        q['domain_hint'] = domains[0]
    r = RedirectResponse(f'https://login.microsoftonline.com/{tenant()}/oauth2/v2.0/authorize?' + urlencode(q), 302)
    cookie = base64.urlsafe_b64encode(payload.encode()).decode() + '.' + str(exp) + '.' + mac
    # Lax: the cookie must come back on Microsoft's top-level redirect to the callback.
    secure = os.getenv('COOKIE_SECURE', 'false') == 'true' or public_url(request).startswith('https://')
    r.set_cookie('forge_oidc', cookie, httponly=True, samesite='lax', secure=secure, max_age=600, path='/api/auth/entra')
    return r


_JWKS = {'at': 0, 'client': None}


def jwks_client():
    import jwt
    if not _JWKS['client'] or time.time() - _JWKS['at'] > 3600:
        _JWKS['client'] = jwt.PyJWKClient(f'https://login.microsoftonline.com/{tenant()}/discovery/v2.0/keys')
        _JWKS['at'] = time.time()
    return _JWKS['client']


def validate_id_token(id_token, nonce):
    import jwt
    key = jwks_client().get_signing_key_from_jwt(id_token).key
    claims = jwt.decode(id_token, key, algorithms=['RS256'], audience=CLIENT_ID(), issuer=f'https://login.microsoftonline.com/{tenant()}/v2.0',
                        options={'require': ['exp', 'iat', 'aud', 'iss', 'sub']}, leeway=60)
    if claims.get('nonce') != nonce:
        raise ValueError('Sign-in response did not match this request')
    return claims


def sign_in_denied(reason):
    return RedirectResponse('/?signin_error=' + reason, 302)


def upsert_user(claims):
    """Returns (user row, error code)."""
    t = (claims.get('tid') or '').lower()
    if t != tenant():
        return None, 'WrongTenant'
    oid = claims.get('oid') or ''
    email = (claims.get('email') or claims.get('preferred_username') or claims.get('upn') or '').strip().lower()
    name = (claims.get('name') or email.split('@')[0]).strip()[:120]
    if not oid or not email:
        return None, 'NoEmail'
    # External (guest / B2B) identities carry an idp claim for their home tenant.
    idp = claims.get('idp') or ''
    if idp and tenant() not in idp and idp != claims.get('iss'):
        return None, 'GuestsNotAllowed'
    if not domain_ok(email):
        return None, 'DomainNotAllowed'
    with db.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        u = c.execute('SELECT * FROM users WHERE oid=?', (oid,)).fetchone()
        if not u:
            by_email = c.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
            if by_email and by_email['oid'] and by_email['oid'] != oid:
                return None, 'AccountConflict'
            u = by_email
        if u and not u['active']:
            return None, 'AccessDisabled'
        if u:
            role = 'admin' if email in admin_emails() else u['role']
            c.execute("UPDATE users SET oid=?,email=?,name=?,provider='entra',role=? WHERE id=?", (oid, email, name, role, u['id']))
            uid = u['id']
        else:
            first = not c.execute("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").fetchone()
            role = 'admin' if email in admin_emails() or (first and not admin_emails()) else os.getenv('DEFAULT_ROLE', 'viewer')
            uid = db.uid()
            c.execute("INSERT INTO users(id,email,name,password,role,created,provider,oid,active) VALUES(?,?,?,?,?,?,?,?,1)", (uid, email, name, '', role, db.now(), 'entra', oid))
            db.audit(c, name, 'user.created', {'email': email, 'role': role, 'provider': 'entra'})
    return db.row('SELECT * FROM users WHERE id=?', (uid,)), None


@router.get('/api/auth/entra/callback')
def callback(request: Request, code: str = '', state: str = '', error: str = '', error_description: str = ''):
    if not enabled():
        raise HTTPException(404, 'Microsoft sign-in is not configured')
    if error:
        return sign_in_denied('EntraError')
    raw = request.cookies.get('forge_oidc', '')
    try:
        b64, exp, mac = raw.rsplit('.', 2)
        payload = base64.urlsafe_b64decode(b64.encode()).decode()
        if not verify('oidc:' + payload, int(exp), mac):
            raise ValueError()
        data = json.loads(payload)
    except Exception:
        return sign_in_denied('SessionExpired')
    if not secrets.compare_digest(data['s'], state or ''):
        return sign_in_denied('StateMismatch')
    try:
        tok = httpx.post(f'https://login.microsoftonline.com/{tenant()}/oauth2/v2.0/token', timeout=20, data={
            'client_id': CLIENT_ID(), 'client_secret': CLIENT_SECRET(), 'grant_type': 'authorization_code', 'code': code,
            'redirect_uri': redirect_uri(request), 'code_verifier': data['v'], 'scope': 'openid profile email'})
        tok.raise_for_status()
        claims = validate_id_token(tok.json()['id_token'], data['n'])
    except Exception:
        return sign_in_denied('TokenInvalid')
    u, err = upsert_user(claims)
    if err:
        with db.connect() as c:
            db.audit(c, (claims.get('preferred_username') or 'unknown')[:120], 'signin.denied', {'reason': err})
        return sign_in_denied(err)
    r = RedirectResponse(data.get('next') or '/', 302)
    set_session_cookie(r, start_session(u['id']), request)
    r.delete_cookie('forge_oidc', path='/api/auth/entra')
    return r


@router.get('/api/auth/providers')
def providers():
    return {'entra': enabled(), 'local': local_login_allowed(), 'domains': allowed_domains()}
