"""End-to-end HTTP + PostgreSQL verification for Stage 3 & Stage 4 capabilities.

Runs ONLY against an explicit disposable loopback instance and database (`piccove_ux_*`)
as a non-root user. Uses Python standard library + psql only.
"""
import base64
import hashlib
import hmac
import http.cookiejar
import json
import os
import struct
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

assert os.geteuid() != 0, 'Run evolution_http.py as non-root'
base = os.environ['PICCOVE_TEST_URL']
db = urllib.parse.urlsplit(os.environ['PICCOVE_TEST_DATABASE_URL'])
assert base.startswith('http://127.0.0.1:')
assert db.hostname == '127.0.0.1' and db.path.startswith('/piccove_ux_')
password = os.environ['PICCOVE_TEST_ADMIN_PASSWORD']
checks = 0


def client():
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )


def request(
    who,
    path,
    method='GET',
    body=None,
    expected=200,
    raw=False,
    extra_headers=None,
    include_origin=True,
    api_prefix=True,
):
    global checks
    headers = {}
    if include_origin:
        headers['Origin'] = base
    if extra_headers:
        headers.update(extra_headers)
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    elif isinstance(body, bytes):
        headers.setdefault(
            'Content-Type', 'multipart/form-data; boundary=evo-boundary'
        )
    full_url = base + ('/api/v1' + path if api_prefix else path)
    req = urllib.request.Request(full_url, data=body, headers=headers, method=method)
    try:
        response = who.open(req, timeout=15)
    except urllib.error.HTTPError as err:
        response = err
    data = response.read()
    assert response.status == expected, (
        method,
        path,
        response.status,
        expected,
        data[:400],
    )
    checks += 1
    if raw:
        return data, response.headers
    return (json.loads(data) if data else None), response.headers


def sql(command):
    env = {
        **os.environ,
        'PGHOST': db.hostname,
        'PGPORT': str(db.port),
        'PGUSER': db.username,
        'PGPASSWORD': db.password,
        'PGDATABASE': db.path[1:],
        'PSQL_HISTORY': '/dev/null',
    }
    return subprocess.check_output(
        ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', command],
        env=env,
        text=True,
    )


def png_chunk(kind, payload):
    return (
        struct.pack('!I', len(payload))
        + kind
        + payload
        + struct.pack('!I', zlib.crc32(kind + payload))
    )


def make_png(extra_chunks=()):
    ihdr = png_chunk(b'IHDR', struct.pack('!IIBBBBB', 4, 4, 8, 2, 0, 0, 0))
    idat = png_chunk(
        b'IDAT', zlib.compress(b''.join(b'\0' + os.urandom(12) for _ in range(4)))
    )
    iend = png_chunk(b'IEND', b'')
    return b'\x89PNG\r\n\x1a\n' + ihdr + b''.join(extra_chunks) + idat + iend


def multipart_file(data, filename='sample.png'):
    return (
        f'--evo-boundary\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n'.encode()
        + data
        + b'\r\n--evo-boundary--\r\n'
    )


def totp_code(secret, offset=0):
    key = base64.b32decode(secret.upper() + '=' * ((8 - len(secret) % 8) % 8))
    counter = struct.pack('>Q', int(time.time() // 30) + offset)
    mac = hmac.new(key, counter, hashlib.sha1).digest()
    pos = mac[19] & 0x0F
    val = (struct.unpack('>I', mac[pos : pos + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f'{val:06d}'


admin, alice, bob, anon = [client() for _ in range(4)]
admin_user, _ = request(admin, '/auth/login', 'POST', {'username': 'admin', 'password': password})
for uname, c in [('evo_alice', alice), ('evo_bob', bob)]:
    request(admin, '/admin/users', 'POST', {'username': uname, 'password': password}, 201)
    request(c, '/auth/login', 'POST', {'username': uname, 'password': password})
alice_me, _ = request(alice, '/me')
alice_id = alice_me['user']['id']
assert alice_me['user']['totp_enabled'] is False

# 1. ETag + 304 Not Modified & Auth-before-304 security check
raw_pub = make_png()
pub_img, _ = request(alice, '/images', 'POST', multipart_file(raw_pub), 201)
body_200, hdrs_200 = request(anon, f"/i/{pub_img['id']}", raw=True, api_prefix=False)
assert body_200 == raw_pub
etag = hdrs_200.get('ETag')
assert etag and 'no-cache' in (hdrs_200.get('Cache-Control') or '')
body_304, _ = request(
    anon,
    f"/i/{pub_img['id']}",
    expected=304,
    raw=True,
    extra_headers={'If-None-Match': etag},
    api_prefix=False,
)
assert body_304 == b''

thumb_200, thumb_hdrs = request(alice, f"/images/{pub_img['id']}/thumbnail", raw=True)
assert thumb_200.startswith(b'\x89PNG')
thumb_etag = thumb_hdrs.get('ETag')
assert thumb_etag
thumb_304, _ = request(
    alice,
    f"/images/{pub_img['id']}/thumbnail",
    expected=304,
    raw=True,
    extra_headers={'If-None-Match': thumb_etag},
)
assert thumb_304 == b''

# Flip public -> private: anonymous with valid ETag MUST get 404, NEVER 304!
request(alice, f"/images/{pub_img['id']}/visibility", 'PATCH', {'is_public': False}, 204)
request(
    anon,
    f"/i/{pub_img['id']}",
    expected=404,
    raw=True,
    extra_headers={'If-None-Match': etag},
    api_prefix=False,
)

# 2. Batch image operations (move / visibility / delete)
img2, _ = request(alice, '/images', 'POST', multipart_file(make_png()), 201)
img3, _ = request(alice, '/images', 'POST', multipart_file(make_png()), 201)
album, _ = request(alice, '/albums', 'POST', {'name': '批量归档'}, 201)
batch_ids = [pub_img['id'], img2['id'], img3['id']]

# Bob cannot batch-modify Alice's images
res_bob, _ = request(
    bob, '/images/batch', 'POST', {'ids': batch_ids, 'action': 'move', 'album_id': None}
)
assert res_bob['processed'] == 0 and res_bob['skipped'] == 3

res_move, _ = request(
    alice,
    '/images/batch',
    'POST',
    {'ids': batch_ids, 'action': 'move', 'album_id': album['id']},
)
assert res_move == {'processed': 3, 'skipped': 0}
assert request(alice, '/albums')[0][0]['image_count'] == 3

res_vis, _ = request(
    alice,
    '/images/batch',
    'POST',
    {'ids': batch_ids, 'action': 'visibility', 'is_public': False},
)
assert res_vis == {'processed': 3, 'skipped': 0}
assert all(not item['is_public'] for item in request(alice, '/images')[0]['items'])

res_del, _ = request(
    alice, '/images/batch', 'POST', {'ids': [img2['id'], img3['id']], 'action': 'delete'}
)
assert res_del == {'processed': 2, 'skipped': 0}

# 3. Stage 4C: EXIF / PNG metadata stripping & source_hash reconciliation
gps_secret = b'GPS:31.2304,121.4737;Author=SecretCamera'
exif_dummy = b'MM\x00*\x00\x00\x00\x08\x00\x00\x00\x00'
tagged_png = make_png(
    extra_chunks=(png_chunk(b'tEXt', b'Comment\x00' + gps_secret), png_chunk(b'eXIf', exif_dummy))
)
assert gps_secret in tagged_png
raw_source_hash = hashlib.sha256(tagged_png).hexdigest()
stripped_img, _ = request(
    alice,
    '/images?strip_metadata=true&private=false',
    'POST',
    multipart_file(tagged_png, 'gps.png'),
    201,
)
stored_bytes, _ = request(anon, f"/i/{stripped_img['id']}", raw=True, api_prefix=False)
assert stored_bytes.startswith(b'\x89PNG')
assert gps_secret not in stored_bytes and b'eXIf' not in stored_bytes
# Interrupted upload reconciliation by original unstripped hash MUST hit via source_hash!
reconciled, _ = request(
    alice, f'/images?content_hash={raw_source_hash}&expected_user_id={alice_id}'
)
assert reconciled['items'][0]['id'] == stripped_img['id']

# 4. Stage 4D: Temporary expiring single-image shares (/s/{token}) on PRIVATE image
# pub_img is currently private (is_public == False)
request(anon, f"/i/{pub_img['id']}", expected=404, api_prefix=False)
share_created, share_hdrs = request(
    alice, f"/images/{pub_img['id']}/shares", 'POST', {'ttl_hours': 24}, 201
)
assert 'no-store' in (share_hdrs.get('Cache-Control') or '')
share_path = urllib.parse.urlsplit(share_created['url']).path
assert share_path.startswith('/s/')
shared_bytes, shared_resp_hdrs = request(anon, share_path, raw=True, api_prefix=False)
assert shared_bytes == raw_pub
assert 'no-store' in (shared_resp_hdrs.get('Cache-Control') or '')
assert shared_resp_hdrs.get('X-Robots-Tag') == 'noindex'

shares_list, _ = request(alice, f"/images/{pub_img['id']}/shares")
assert len(shares_list) == 1 and shares_list[0]['id'] == share_created['id']
request(bob, f"/images/{pub_img['id']}/shares", expected=404)

# Revoke share -> immediate 404
request(alice, f"/images/{pub_img['id']}/shares/{share_created['id']}", 'DELETE', expected=204)
request(anon, share_path, expected=404, api_prefix=False)

# Expired share -> 404
share2, _ = request(alice, f"/images/{pub_img['id']}/shares", 'POST', {'ttl_hours': 1}, 201)
sql(f"UPDATE image_shares SET expires_at = NOW() - interval '2 minutes' WHERE id = '{share2['id']}'")
request(anon, urllib.parse.urlsplit(share2['url']).path, expected=404, api_prefix=False)

# 5. Stage 4B: Upload API Tokens (PicGo / CLI) & strict Origin/Cookie isolation
tok_created, tok_hdrs = request(
    alice,
    '/me/tokens',
    'POST',
    {'name': 'PicGo Desktop', 'default_album_id': album['id'], 'default_public': False},
    201,
)
assert tok_created['token'].startswith('pcv_')
assert 'no-store' in (tok_hdrs.get('Cache-Control') or '')
sec_with_tok, _ = request(alice, '/me/security')
assert len(sec_with_tok['api_tokens']) == 1

# Upload with Bearer token and NO Origin header on fresh cookieless client -> 201!
cli_uploaded, _ = request(
    client(),
    '/images',
    'POST',
    multipart_file(make_png(), 'from-cli.png'),
    201,
    extra_headers={'Authorization': f"Bearer {tok_created['token']}"},
    include_origin=False,
)
assert cli_uploaded['is_public'] is False
assert cli_uploaded['album_id'] == album['id']
assert request(alice, '/me/tokens')[0][0]['last_used_at'] is not None

# Invalid Bearer MUST NOT fall back to valid session cookie!
request(
    alice,
    '/images',
    'POST',
    multipart_file(make_png()),
    401,
    extra_headers={'Authorization': 'Bearer pcv_invalid'},
    include_origin=False,
)
# Non-upload write endpoint with Bearer and no Origin MUST still be blocked by CSRF guard!
request(
    alice,
    f"/images/{cli_uploaded['id']}",
    'DELETE',
    expected=403,
    extra_headers={'Authorization': f"Bearer {tok_created['token']}"},
    include_origin=False,
)
# Revoke token -> 401
request(alice, f"/me/tokens/{tok_created['id']}", 'DELETE', expected=204)
request(
    client(),
    '/images',
    'POST',
    multipart_file(make_png()),
    401,
    extra_headers={'Authorization': f"Bearer {tok_created['token']}"},
    include_origin=False,
)

# 6. AI Conversation rename / soft-delete & daily quota preservation
conv, _ = request(alice, '/ai/conversations', 'POST', {})
conv_id = conv['id']
request(alice, f'/ai/conversations/{conv_id}', 'PATCH', {'title': '赛博海湾重绘'}, 204)
assert request(alice, '/ai/conversations')[0]['items'][0]['title'] == '赛博海湾重绘'
# Seed a running message -> DELETE must reject with 409
msg_id = '11111111-2222-4333-8444-555555555555'
sql(
    f"INSERT INTO ai_messages(id, conversation_id, user_id, prompt, status) VALUES('{msg_id}', '{conv_id}', '{alice_id}', 'test', 'running')"
)
request(alice, f'/ai/conversations/{conv_id}', 'DELETE', expected=409)
sql(f"UPDATE ai_messages SET status='completed', had_image=TRUE WHERE id='{msg_id}'")
used_before = request(alice, '/ai/status')[0]['used']
assert used_before == 1
request(alice, f'/ai/conversations/{conv_id}', 'DELETE', expected=204)
assert request(alice, '/ai/conversations')[0]['items'] == []
request(alice, f'/ai/conversations/{conv_id}', expected=404)
# Archiving conversation MUST NOT reset daily quota!
assert request(alice, '/ai/status')[0]['used'] == 1

# 7. Stage 4A: 2FA Recovery Codes + Admin 2FA Reset
started, start_hdrs = request(alice, '/me/totp/start', 'POST', {'current_password': password})
assert 'no-store' in (start_hdrs.get('Cache-Control') or '')
confirmed, _ = request(
    alice,
    '/me/totp/confirm',
    'POST',
    {'current_password': password, 'code': totp_code(started['secret'], -1)},
    200,
)
codes = confirmed['recovery_codes']
assert len(codes) == 8
assert request(alice, '/me')[0]['user']['totp_enabled'] is True

# Regenerate recovery codes using first recovery code
regen, _ = request(
    alice,
    '/me/totp/recovery',
    'POST',
    {'current_password': password, 'code': codes[0]},
    200,
)
new_codes = regen['recovery_codes']
assert len(new_codes) == 8 and new_codes != codes
request(alice, '/auth/logout', 'POST', expected=204)
# Old recovery code must fail
request(
    alice,
    '/auth/login',
    'POST',
    {'username': 'evo_alice', 'password': password, 'code': codes[1]},
    400,
)
# New recovery code logs in once, then cannot be replayed
request(
    alice,
    '/auth/login',
    'POST',
    {'username': 'evo_alice', 'password': password, 'code': new_codes[0].lower().replace('-', ' ')},
    200,
)
assert request(alice, '/me/security')[0]['recovery_remaining'] == 7

# Admin cannot reset another admin's 2FA over web API, but CAN reset non-admin Alice's 2FA
request(admin, f"/admin/users/{admin_user['id']}/reset-2fa", 'POST', expected=400)
request(admin, f'/admin/users/{alice_id}/reset-2fa', 'POST', expected=204)
# Alice's session was revoked and 2FA cleared
request(alice, '/me', expected=401)
request(alice, '/auth/login', 'POST', {'username': 'evo_alice', 'password': password}, 200)
assert request(alice, '/me')[0]['user']['totp_enabled'] is False

print(f'PASS {checks} Stage 3 & Stage 4 evolution HTTP/DB checks!')
