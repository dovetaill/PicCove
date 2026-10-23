"""Run only against a disposable PicCove database and upload directory.
PICCOVE_TEST_URL, PICCOVE_TEST_ADMIN_PASSWORD must be explicitly provided.
Uses only Python's standard library; creates and deletes test accounts/images.
"""
import http.cookiejar
import json
import os
import re
from urllib.parse import urlsplit
import struct
import urllib.error
import urllib.request
import zlib

BASE = os.environ['PICCOVE_TEST_URL']
assert BASE.startswith('http://127.0.0.1:'), 'Only disposable local test instances are allowed'
PASSWORD = os.environ['PICCOVE_TEST_ADMIN_PASSWORD']
ORIGIN = os.environ.get('PICCOVE_TEST_ORIGIN', 'http://127.0.0.1:5173')
assert os.geteuid() != 0, 'Run API verification as an unprivileged user'
checks = 0

def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(who, path, method='GET', body=None, expected=200, origin=ORIGIN, raw=False):
    global checks
    headers = {'Origin': origin}
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    elif isinstance(body, bytes):
        headers['Content-Type'] = 'multipart/form-data; boundary=piccove-test-boundary'
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        response = who.open(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    data = response.read()
    assert response.status == expected, (method, path, response.status, expected, data[:400])
    checks += 1
    if raw:
        return data
    return json.loads(data) if data else None

def png(width=2, height=3):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    pixels = b''.join(b'\0' + os.urandom(width * 3) for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')

def upload(who, data, expected=201, private=False):
    body = b'--piccove-test-boundary\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n' + data + b'\r\n--piccove-test-boundary--\r\n'
    return request(who, '/api/v1/images' + ('?private=true' if private else ''), 'POST', body, expected)

def login(who, name, password=PASSWORD, expected=200):
    return request(who, '/api/v1/auth/login', 'POST', {'username': name, 'password': password}, expected)

admin, alice, bob, anonymous = [client() for _ in range(4)]
assert not request(anonymous, '/api/v1/settings')['registration_open']
request(anonymous, '/api/v1/images', expected=401)
upload(anonymous, png(), 401)
request(anonymous, '/api/v1/auth/register', 'POST', {'username': 'closed', 'password': PASSWORD}, 403)
login(admin, 'admin')
request(admin, '/api/v1/settings', 'PATCH', {'registration_open': True}, 403, origin='https://untrusted.example')
for name in ['alice', 'bobby']:
    request(admin, '/api/v1/admin/users', 'POST', {'username': name, 'password': PASSWORD}, 201)
a = login(alice, 'alice')
b = login(bob, 'bobby')
request(alice, '/api/v1/admin/users', expected=403)
for endpoint in ['/admin/storage', '/admin/system']:
    request(alice, '/api/v1' + endpoint, expected=403)
    request(anonymous, '/api/v1' + endpoint, expected=401)
request(alice, '/api/v1/admin/storage', 'PATCH', {'upload_dir': '/data/uploads'}, 403)
request(alice, '/api/v1/admin/system/restart', 'POST', expected=403)
request(admin, '/api/v1/admin/storage', 'PATCH', {'upload_dir': '../bad'}, 400)
request(admin, '/api/v1/admin/storage', 'PATCH', {'upload_dir': '/does-not-exist-piccove-test'}, 400)
assert request(admin, '/api/v1/admin/system')['version']
original_storage = request(admin, '/api/v1/admin/storage')['upload_dir']
request(alice, '/api/v1/images?all=true', expected=403)
request(alice, '/api/v1/settings', 'PATCH', {'registration_open': True}, 403)
request(admin, '/api/v1/settings', 'PATCH', {'registration_open': True}, 204)
request(anonymous, '/api/v1/auth/register', 'POST', {'username': 'publicuser', 'password': PASSWORD}, 201)
request(admin, '/api/v1/settings', 'PATCH', {'registration_open': False}, 204)
request(anonymous, '/api/v1/auth/register', 'POST', {'username': 'closedagain', 'password': PASSWORD}, 403)
login(client(), 'publicuser')
upload(alice, b'not an image', 400)
upload(alice, png()[:40], 400)
upload(alice, b'x' * (10 * 1024 * 1024 + 1), 400)
pixels = png(1000, 1000)
image = upload(alice, pixels)
image_path = '/api/v1/images/' + image['id']
public_path = '/i/' + image['id']
assert request(anonymous, public_path, raw=True) == pixels
dated_path = urlsplit(image['url']).path
assert re.fullmatch(r'/i/\d{4}/\d{2}/\d{2}/[0-9a-f-]+\.png', dated_path)
assert request(anonymous, dated_path, raw=True) == pixels
request(admin, '/api/v1/admin/storage', 'PATCH', {'upload_dir': '/data'}, 400)
assert image['is_public'] is True
assert request(anonymous, '/api/v1/settings')['private_images'] is True
private = upload(alice, png(), private=True)
assert private['is_public'] is False
private_path = '/i/' + private['id']
visibility_path = '/api/v1/images/' + private['id'] + '/visibility'
request(anonymous, urlsplit(private['url']).path, expected=404)
request(anonymous, private_path, expected=404)
request(bob, private_path, expected=404)
assert request(alice, private_path, raw=True) == request(admin, private_path, raw=True)
request(bob, visibility_path, 'PATCH', {'is_public': True}, 404)
request(alice, visibility_path, 'PATCH', {'is_public': True}, 403, origin='https://untrusted.example')
request(alice, visibility_path, 'PATCH', {'is_public': True}, 204)
assert request(anonymous, private_path, raw=True)
request(alice, visibility_path, 'PATCH', {'is_public': False}, 204)
request(anonymous, private_path, expected=404)
request(alice, '/api/v1/images/' + private['id'], 'DELETE', expected=204)
request(alice, private_path, expected=404)
assert request(bob, '/api/v1/images')['items'] == []
request(bob, image_path, 'DELETE', expected=404)
request(bob, image_path, 'PATCH', {'original_name': 'stolen', 'album_id': None}, 404)
assert request(alice, '/api/v1/me')['used_bytes'] == len(pixels)
album = request(alice, '/api/v1/albums', 'POST', {'name': '旅行'}, 201)
foreign_album = request(bob, '/api/v1/albums', 'POST', {'name': '私人分类'}, 201)
request(alice, image_path, 'PATCH', {'original_name': 'renamed.png', 'album_id': foreign_album['id']}, 404)
request(alice, image_path, 'PATCH', {'original_name': 'renamed.png', 'album_id': album['id']}, 204)
assert request(alice, '/api/v1/images?album_id=' + album['id'])['items'][0]['url'] == image['url']
request(bob, '/api/v1/albums/' + album['id'], 'DELETE', expected=404)
request(alice, '/api/v1/albums/' + album['id'], 'DELETE', expected=204)
assert request(alice, '/api/v1/images')['items'][0]['album_id'] is None
assert request(anonymous, public_path, raw=True) == pixels
request(admin, '/api/v1/admin/users/' + a['id'], 'PATCH', {'quota_bytes': len(pixels), 'disabled': False}, 204)
upload(alice, png(), 400)
assert request(anonymous, public_path, raw=True) == pixels
request(admin, '/api/v1/admin/users/' + a['id'], 'PATCH', {'quota_bytes': 1073741824, 'disabled': True}, 204)
request(alice, '/api/v1/me', expected=401)
login(client(), 'alice', expected=401)
assert request(anonymous, public_path, raw=True) == pixels
request(admin, '/api/v1/admin/users/' + a['id'], 'PATCH', {'quota_bytes': 1073741824, 'disabled': False, 'password': 'replacement-password'}, 204)
login(alice, 'alice', 'replacement-password')
request(alice, '/api/v1/me/password', 'POST', {'current_password': 'wrong-password', 'password': PASSWORD}, 401)
request(alice, '/api/v1/me/password', 'POST', {'current_password': 'replacement-password', 'password': PASSWORD}, 204)
request(alice, '/api/v1/me', expected=401)
login(alice, 'alice')
request(admin, image_path, 'DELETE', expected=204)
request(anonymous, public_path, expected=404)
assert request(alice, '/api/v1/me')['used_bytes'] == 0
# Leave one image for the isolated backup/restore verification.
kept = upload(bob, png(20, 20))
request(bob, '/api/v1/auth/logout', 'POST', expected=204)
request(bob, '/api/v1/me', expected=401)
request(anonymous, '/i/00000000-0000-0000-0000-000000000000', expected=404)
request(anonymous, '/api/v1/images?page=0', expected=401)
for attempt in range(21):
    # Existing login attempts count toward the same IP limit; accept either until it is saturated.
    try:
        request(anonymous, '/api/v1/auth/login', 'POST', {'username': 'missing', 'password': PASSWORD}, 401)
    except AssertionError as error:
        assert error.args[0][2] == 429
        break
else:
    raise AssertionError('Login limiter did not activate')
print(json.dumps({'checks': checks, 'backup_image_id': kept['id'], 'result': 'passed'}))
