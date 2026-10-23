"""Targeted integration checks. Run only with an empty disposable PostgreSQL database.

PICCOVE_STORAGE_TEST_WORK, PICCOVE_STORAGE_TEST_BINARY and PICCOVE_STORAGE_TEST_DB
must name task-owned resources. The runner starts/stops only its own API process.
"""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib


def main():
    assert os.geteuid() != 0
    work = Path(os.environ['PICCOVE_STORAGE_TEST_WORK'])
    assert work.is_dir() and not (work / 'runtime').exists()
    runtime = work / 'runtime'
    runtime.mkdir()
    original, target, imports = [runtime / name for name in ['original', 'target', 'imports']]
    for path in [original, target, imports]:
        path.mkdir()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    database = os.environ['PICCOVE_STORAGE_TEST_DB']
    assert urllib.parse.urlsplit(database).hostname == '127.0.0.1'
    env = {**os.environ, 'DATABASE_URL': database, 'UPLOAD_DIR': str(original),
           'PICCOVE_STORAGE_ROOTS': str(runtime), 'PICCOVE_IMPORT_DIR': str(imports),
           'PICCOVE_ADMIN_USERNAME': 'admin', 'PICCOVE_ADMIN_PASSWORD': 'storage-test-password',
           'CORS_ORIGIN': base, 'PUBLIC_BASE_URL': base, 'LISTEN_ADDR': f'127.0.0.1:{port}'}
    process = None
    groups = []
    log = (runtime / 'api.log').open('wb')
    checks = 0

    def client():
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    admin, user, anonymous = [client() for _ in range(3)]

    def request(who, path, method='GET', body=None, expected=200, raw=False):
        nonlocal checks
        headers = {'Origin': base}
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        elif isinstance(body, bytes):
            headers['Content-Type'] = 'multipart/form-data; boundary=storage-test'
        try:
            response = who.open(urllib.request.Request(base + path, body, headers, method=method), timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        data = response.read()
        assert response.status == expected, (path, response.status, expected, data[:500])
        checks += 1
        return data if raw else json.loads(data) if data else None

    def stop():
        nonlocal process
        if process:
            os.killpg(process.pid, signal.SIGINT)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            process = None

    def start():
        nonlocal process
        process = subprocess.Popen([os.environ['PICCOVE_STORAGE_TEST_BINARY']], env=env, cwd=runtime,
                                   stdout=log, stderr=log, start_new_session=True)
        groups.append(process.pid)
        print(f'API PID/PGID={process.pid} UID={os.geteuid()} cwd={runtime} port={port}', flush=True)
        for _ in range(100):
            assert process.poll() is None, (runtime / 'api.log').read_text()
            try:
                request(anonymous, '/api/health', raw=True)
                return
            except (OSError, urllib.error.URLError):
                time.sleep(.1)
        raise AssertionError('API start timeout')

    def png(color=b'\x20\x80\x40'):
        def chunk(kind, data):
            return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
        pixels = b''.join(b'\0' + color * 800 for _ in range(600))
        return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 800, 600, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')

    image_bytes = png()

    def upload(private=False):
        body = b'--storage-test\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n' + (png(b'\x40\x80\x20') if private else image_bytes) + b'\r\n--storage-test--\r\n'
        return request(user, '/api/v1/images' + ('?private=true' if private else ''), 'POST', body, 201)

    def path(url):
        return urllib.parse.urlsplit(url).path

    def wait_job(job_id, status='completed'):
        for _ in range(150):
            job = next(j for j in request(admin, '/api/v1/file-jobs') if j['id'] == job_id)
            if job['status'] in ['completed', 'failed']:
                assert job['status'] == status, (job, request(admin, '/api/v1/file-jobs/' + job_id))
                return job
            time.sleep(.1)
        raise AssertionError('job timeout')

    def sql(statement):
        subprocess.run(['/usr/lib/postgresql/17/bin/psql', '-X', database, '-v', 'ON_ERROR_STOP=1', '-c', statement], check=True, stdout=subprocess.DEVNULL)

    try:
        start()
        request(admin, '/api/v1/auth/login', 'POST', {'username': 'admin', 'password': 'storage-test-password'})
        request(admin, '/api/v1/admin/users', 'POST', {'username': 'alice', 'password': 'storage-test-password'}, 201)
        account = request(user, '/api/v1/auth/login', 'POST', {'username': 'alice', 'password': 'storage-test-password'})
        uid = account['id'] if 'id' in account else account['user']['id']
        for endpoint in ['/storage-locations', '/file-jobs', '/import-candidates']:
            request(user, '/api/v1' + endpoint, expected=403)
            request(anonymous, '/api/v1' + endpoint, expected=401)
        request(user, '/api/v1/storage-locations', 'POST', {'path': str(target)}, 403)
        request(admin, '/api/v1/storage-locations', 'POST', {'path': '/tmp'}, 400)
        request(admin, '/api/v1/storage-locations', 'POST', {'path': str(imports)}, 400)
        (runtime / 'linked').symlink_to(target)
        request(admin, '/api/v1/storage-locations', 'POST', {'path': str(runtime / 'linked')}, 400)
        request(admin, '/api/v1/storage-locations', 'POST', {'path': str(target)}, 201)
        locations = request(admin, '/api/v1/storage-locations')['items']
        source_id = next(v['id'] for v in locations if v['default'])
        target_id = next(v['id'] for v in locations if v['path'] == str(target))
        public, private = upload(), upload(True)
        sql(f"UPDATE images SET content_hash=NULL WHERE id='{public['id']}'")
        duplicate_body = b'--storage-test\r\nContent-Disposition: form-data; name="file"; filename="duplicate.png"\r\nContent-Type: image/png\r\n\r\n' + image_bytes + b'\r\n--storage-test--\r\n'
        missing_file = original / path(public['url']).removeprefix('/i/')
        held_file = missing_file.with_suffix('.held')
        missing_file.rename(held_file)
        try:
            replacement = request(user, '/api/v1/images', 'POST', duplicate_body, 201)
            assert replacement['id'] != public['id'] and not replacement.get('duplicate')
            assert request(anonymous, path(replacement['url']), raw=True) == image_bytes
            request(user, '/api/v1/images/' + replacement['id'], 'DELETE', expected=204)
        finally:
            held_file.rename(missing_file)
        assert missing_file.read_bytes() == image_bytes
        reused = request(user, '/api/v1/images', 'POST', duplicate_body, 200)
        assert reused['duplicate'] and reused['id'] == public['id']
        assert len(request(user, '/api/v1/images')['items']) == 2
        old_url = path(public['url'])
        assert request(anonymous, old_url, raw=True) == image_bytes
        assert request(anonymous, '/i/' + public['id'], raw=True) == image_bytes
        thumbnail = request(anonymous, path(public['thumbnail_url']), raw=True)
        assert struct.unpack('!II', thumbnail[16:24]) == (480, 360)
        request(anonymous, path(private['thumbnail_url']), expected=404)
        assert request(user, path(private['thumbnail_url']), raw=True)
        conflict_path = target / old_url.removeprefix('/i/')
        conflict_path.parent.mkdir(parents=True)
        conflict_path.write_bytes(b'conflict')
        job_id = request(admin, '/api/v1/file-jobs/migrate', 'POST', {'source_id': source_id, 'target_id': target_id})['id']
        wait_job(job_id, 'failed')
        assert conflict_path.read_bytes() == b'conflict'
        assert request(anonymous, old_url, raw=True) == image_bytes
        conflict_path.unlink()
        request(admin, '/api/v1/file-jobs/' + job_id + '/retry', 'POST', expected=204)
        wait_job(job_id)
        assert request(anonymous, old_url, raw=True) == image_bytes
        assert request(anonymous, '/i/' + public['id'], raw=True) == image_bytes
        assert request(user, path(private['url']), raw=True) == png(b'\x40\x80\x20')
        request(anonymous, path(private['url']), expected=404)
        relative = old_url.removeprefix('/i/')
        assert (original / relative).read_bytes() == (target / relative).read_bytes() == image_bytes
        # Emulate a crash after switching the image but before marking its job item complete.
        stop()
        sql(f"UPDATE file_job_items SET status='running' WHERE job_id='{job_id}'; UPDATE file_jobs SET status='running' WHERE id='{job_id}'")
        start()
        wait_job(job_id)
        # A changed source must not be removed even though the target is valid.
        (original / relative).write_bytes(b'changed')
        cleanup = request(admin, f'/api/v1/file-jobs/{job_id}/cleanup', 'POST')['id']
        wait_job(cleanup, 'failed')
        assert (original / relative).read_bytes() == b'changed'
        assert request(anonymous, old_url, raw=True) == image_bytes
        # Deleted images remove migration copies as well as active originals.
        request(user, '/api/v1/images/' + private['id'], 'DELETE', expected=204)
        request(user, path(private['thumbnail_url']), expected=404)
        assert not (original / path(private['url']).removeprefix('/i/')).exists()
        # Directory identity mismatch is rejected even when a new writable directory exists there.
        target.rename(runtime / 'target-offline')
        target.mkdir()
        request(anonymous, old_url, expected=400)
        body = b'--storage-test\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n\r\n' + image_bytes + b'\r\n--storage-test--\r\n'
        request(user, '/api/v1/images', 'POST', body, 400)
        assert not list(target.iterdir())
        target.rmdir()
        (runtime / 'target-offline').rename(target)
        assert request(anonymous, old_url, raw=True) == image_bytes
        (imports / 'photo.png').write_bytes(image_bytes)
        (imports / 'broken.png').write_bytes(b'bad image')
        (imports / 'unfinished.part').write_bytes(image_bytes)
        (imports / 'linked.png').symlink_to(imports / 'photo.png')
        scan = request(admin, '/api/v1/import-candidates')['items']
        assert {f['key'] for f in scan} == {'photo.png', 'broken.png'}
        import_id = request(admin, '/api/v1/file-jobs/import', 'POST', {'user_id': uid, 'files': scan})['id']
        result = wait_job(import_id, 'failed')
        assert result['completed'] == 1 and result['failed'] == 1
        count = len(request(user, '/api/v1/images')['items'])
        good = [f for f in scan if f['key'] == 'photo.png']
        duplicate = request(admin, '/api/v1/file-jobs/import', 'POST', {'user_id': uid, 'files': good})['id']
        wait_job(duplicate)
        assert len(request(user, '/api/v1/images')['items']) == count
        stop()
        sql(f"UPDATE file_job_items SET status='running' WHERE job_id='{duplicate}'; UPDATE file_jobs SET status='running' WHERE id='{duplicate}'")
        start()
        wait_job(duplicate)
        assert len(request(user, '/api/v1/images')['items']) == count
        imported = next(p for p in request(user, '/api/v1/images')['items'] if p['original_name'] == 'photo.png')
        assert not imported['is_public']
        request(anonymous, path(imported['url']), expected=404)
        assert request(user, path(imported['url']), raw=True) == image_bytes
        assert (imports / 'photo.png').read_bytes() == image_bytes
        (imports / 'photo.png').write_bytes(image_bytes + b'changed')
        request(admin, '/api/v1/file-jobs/import', 'POST', {'user_id': uid, 'files': good}, 400)
        request(admin, '/api/v1/file-jobs/import', 'POST', {'user_id': uid, 'files': [{'key': '../escape.png', 'size': 1, 'signature': 'x'}]}, 400)
        request(admin, '/api/v1/file-jobs/' + import_id + '/retry', 'POST', expected=204)
        wait_job(import_id, 'failed')
        # Quota enforcement goes through the same upload function as ordinary Web uploads.
        (imports / 'quota.png').write_bytes(image_bytes)
        quota_file = [f for f in request(admin, '/api/v1/import-candidates')['items'] if f['key'] == 'quota.png']
        sql(f"UPDATE users SET quota_bytes=0 WHERE id='{uid}'")
        quota_job = request(admin, '/api/v1/file-jobs/import', 'POST', {'user_id': uid, 'files': quota_file})['id']
        wait_job(quota_job, 'failed')
        assert len(request(user, '/api/v1/images')['items']) == count
        assert hashlib.sha256(request(anonymous, old_url, raw=True)).digest() == hashlib.sha256(image_bytes).digest()
        # A replaced default mount is rejected before creating a lock file on the wrong disk.
        stop()
        original.rename(runtime / 'original-offline')
        original.mkdir()
        process = subprocess.Popen([os.environ['PICCOVE_STORAGE_TEST_BINARY']], env=env, cwd=runtime,
                                   stdout=log, stderr=log, start_new_session=True)
        groups.append(process.pid)
        assert process.wait(timeout=10) != 0
        process = None
        assert not list(original.iterdir())
        original.rmdir()
        (runtime / 'original-offline').rename(original)
        print(f'storage HTTP checks passed: {checks}; migration/recovery/import/deduplication/permissions/thumbnail/quota', flush=True)
    finally:
        stop()
        log.close()
        for group in groups:
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                continue
            raise AssertionError(f'process group remains: {group}')
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', port))
        print(f'API groups stopped={groups}; port {port} released; runtime artifacts remain under {runtime} for caller cleanup', flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    main()
