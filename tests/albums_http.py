"""Album summaries and existing contracts, only on an explicit disposable API/database.

PICCOVE_TEST_URL and PICCOVE_TEST_DATABASE_URL must use loopback addresses;
the database name must start with piccove_ux_. SQL is used only to seed review
states which the album list must respect. No external review service is called.
"""
import http.cookiejar
import json
import os
import struct
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
import socket
import time

assert os.geteuid() != 0
base = os.environ['PICCOVE_TEST_URL']
db = urllib.parse.urlsplit(os.environ['PICCOVE_TEST_DATABASE_URL'])
assert base.startswith('http://127.0.0.1:')
assert db.hostname == '127.0.0.1' and db.path.startswith('/piccove_ux_')
password = os.environ['PICCOVE_TEST_ADMIN_PASSWORD']
checks = 0


def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(who, path, method='GET', body=None, expected=200, raw=False):
    global checks
    headers = {'Origin': base}
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    elif isinstance(body, bytes):
        headers['Content-Type'] = 'multipart/form-data; boundary=album-test'
    req = urllib.request.Request(base + '/api/v1' + path, data=body, headers=headers, method=method)
    try:
        response = who.open(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    data = response.read()
    assert response.status == expected, (method, path, response.status, expected, data[:300])
    checks += 1
    return data if raw else json.loads(data) if data else None


def sql(command):
    env = {**os.environ, 'PGHOST': db.hostname, 'PGPORT': str(db.port),
           'PGUSER': db.username, 'PGPASSWORD': db.password,
           'PGDATABASE': db.path[1:], 'PSQL_HISTORY': '/dev/null'}
    return subprocess.check_output(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', command], env=env, text=True)


def upload(who, album, private=False):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 2, 2, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0' + os.urandom(6) + b'\0' + os.urandom(6))) + chunk(b'IEND', b'')
    body = b'--album-test\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n' + png + b'\r\n--album-test--\r\n'
    return request(who, f'/images?album_id={album}&private={str(private).lower()}', 'POST', body, 201)


admin, alice, bob, anonymous = [client() for _ in range(4)]
request(admin, '/auth/login', 'POST', {'username': 'admin', 'password': password})
for name, who in [('album_alice', alice), ('album_bob', bob)]:
    request(admin, '/admin/users', 'POST', {'username': name, 'password': password}, 201)
    request(who, '/auth/login', 'POST', {'username': name, 'password': password})
owner = request(alice, '/me')['user']['id']
album = request(alice, '/albums', 'POST', {'name': '旅行', 'description': '测试描述'}, 201)
assert set(album) == {'id', 'name', 'description'}
album_id = str(uuid.UUID(album['id']))
empty = request(alice, '/albums')[0]
assert empty == {**album, 'image_count': 0, 'cover_id': None}
assert request(bob, '/albums') == []
request(anonymous, '/albums', expected=401)
assert request(admin, f'/import-albums/{owner}')[0] == album

public = upload(alice, album_id)
private = upload(alice, album_id, private=True)
summary = request(alice, '/albums')[0]
assert summary['image_count'] == 2 and summary['cover_id'] == private['id']
preview = request(alice, f"/images/{private['id']}/thumbnail", raw=True)
assert preview.startswith(b'\x89PNG')
request(anonymous, f"/images/{private['id']}/thumbnail", expected=404)
request(bob, f"/images/{private['id']}/thumbnail", expected=404)

private_id = str(uuid.UUID(private['id']))
public_id = str(uuid.UUID(public['id']))
assert request(alice, f'/images?ids={private_id},{public_id}')['has_more'] is False
assert len(request(alice, f'/images?ids={private_id},{public_id}')['items']) == 2
assert request(bob, f'/images?ids={private_id}')['items'] == []
request(anonymous, f'/images?ids={private_id}', expected=401)
request(bob, f'/images?ids={private_id}&all=true', expected=403)
assert len(request(admin, f'/images?ids={private_id}&all=true')['items']) == 1
request(alice, '/images?ids=invalid', expected=400)
request(alice, '/images?ids=' + ','.join([public_id] * 49), expected=400)
digest = sql(f"SELECT content_hash FROM images WHERE id='{public_id}'").strip()
assert request(alice, f'/images?content_hash={digest}&expected_user_id={owner}')['items'][0]['id'] == public_id
assert request(bob, f'/images?content_hash={digest}')['items'] == []
request(alice, '/images?content_hash=bad', expected=400)
request(bob, f'/images?content_hash={digest}&expected_user_id={owner}', expected=409)
request(bob, f'/images?expected_user_id={owner}', 'POST', b'--album-test--\r\n', expected=409)
sql(f"UPDATE images SET moderation_status='blocked' WHERE id='{private_id}'")
assert request(alice, f'/images?ids={private_id}')['items'][0]['moderation_status'] == 'blocked'
summary = request(alice, '/albums')[0]
assert summary['image_count'] == 2 and summary['cover_id'] == public_id
sql(f"UPDATE images SET moderation_status='review' WHERE id='{public_id}'")
assert request(alice, '/albums')[0]['cover_id'] is None
sql(f"UPDATE images SET moderation_status='pending',moderation_hold=TRUE WHERE id='{private_id}'")
assert request(alice, '/albums')[0]['cover_id'] == private_id
request(alice, f'/images/{private_id}/thumbnail', raw=True)
request(anonymous, f'/images/{private_id}/thumbnail', expected=404)
sql(f"UPDATE images SET deleted_at=NOW() WHERE id='{private_id}'")
assert request(alice, f'/images?ids={private_id}')['items'][0]['deleted_at'] is not None
summary = request(alice, '/albums')[0]
assert summary['image_count'] == 1 and summary['cover_id'] is None
sql(f"UPDATE images SET deleted_at=NULL,moderation_status='passed',moderation_hold=FALSE WHERE id IN ('{private_id}','{public_id}')")

request(alice, f'/images/{public_id}', 'PATCH', {'original_name': '改名.png', 'album_id': None}, 204)
assert request(alice, '/albums')[0]['image_count'] == 1
listed = request(alice, '/images')['items']
assert next(item for item in listed if item['id'] == public_id)['url'] == public['url']
request(bob, f'/albums/{album_id}', 'DELETE', expected=404)
request(alice, f'/albums/{album_id}', 'DELETE', expected=204)
assert request(alice, '/albums') == []
listed = request(alice, '/images')['items']
assert len(listed) == 2 and all(item['album_id'] is None for item in listed)
assert next(item for item in listed if item['id'] == private_id)['is_public'] is False
cookie = urllib.request.Request(base + '/api/v1/images')
next(handler for handler in alice.handlers if isinstance(handler, urllib.request.HTTPCookieProcessor)).cookiejar.add_cookie_header(cookie)
address = urllib.parse.urlsplit(base)
with socket.create_connection((address.hostname, address.port), timeout=15) as pending:
    headers = f'POST /api/v1/images HTTP/1.1\r\nHost: {address.netloc}\r\nOrigin: {base}\r\nCookie: {cookie.get_header("Cookie")}\r\nContent-Type: multipart/form-data; boundary=album-test\r\nContent-Length: 10000\r\n\r\n--album-test\r\n'
    pending.sendall(headers.encode())
    time.sleep(0.2)
    assert len(request(alice, '/images')['items']) == 2
    started = time.monotonic()
    request(alice, f'/images?content_hash={digest}', expected=503)
    assert time.monotonic() - started < 13
print('PASS targeted metadata and hash reconciliation: access isolation, limits, latest/deleted states, expected owner and bounded in-flight wait')
print(f'PASS {checks} HTTP checks: empty/count/cover, owner isolation, review/deletion states, unchanged create/import responses, move and album deletion retain images/links/privacy')
