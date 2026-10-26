"""AI integration checks with a mock provider and an EMPTY disposable PostgreSQL database.
Run as non-root with PICCOVE_AI_TEST_WORK/BINARY/DB pointing to task-owned resources.
No real AI credentials, production database, or external provider is used.
"""
import base64
from email.parser import BytesParser
from email.policy import default
import http.cookiejar
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib


def png(seed, large=False):
    width = 600 if large else 8
    pixels = bytes((seed + i * 17) % 256 for i in range(width * 3))
    raw = b''.join(b'\0' + (os.urandom(width * 3) if large else pixels) for _ in range(width))
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, width, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def main():
    assert os.geteuid() != 0, 'Use a task-owned non-root identity'
    work = Path(os.environ['PICCOVE_AI_TEST_WORK'])
    runtime = work / 'ai-runtime'
    assert work.is_dir() and not runtime.exists()
    runtime.mkdir()
    uploads = runtime / 'uploads'
    uploads.mkdir()
    database = os.environ['PICCOVE_AI_TEST_DB']
    assert urllib.parse.urlsplit(database).hostname == '127.0.0.1'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    checks = 0
    process = None
    groups = []
    state = {'decision': 'passed', 'generation': 0, 'review_calls': 0, 'last': None, 'slow': False}

    class Provider(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            assert self.path == '/v1/models'
            assert self.headers['Authorization'] == 'Bearer test-secret'
            data = json.dumps({'data': [{'id': 'image-test'}, {'id': 'chat-test'}, {'id': 'image-test'}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_POST(self):
            raw = self.rfile.read(int(self.headers['Content-Length']))
            if self.path == '/v1/images/edits':
                message = BytesParser(policy=default).parsebytes(b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\n\r\n' + raw)
                body = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True) for part in message.iter_parts()}
                assert body['image'].startswith(b'\x89PNG') and body['prompt'] == b'edit direct'
                assert body['model'] == b'image-test'
            else:
                body = json.loads(raw)
            assert self.headers['Authorization'] == 'Bearer test-secret'
            if self.path in ('/v1/images/generations', '/v1/images/edits'):
                state['last'] = self.path
                if self.path.endswith('/generations'):
                    assert body == {'model': 'image-test', 'prompt': 'direct', 'n': 1}
                result = {'data': [{'b64_json': base64.b64encode(png(91 if self.path.endswith('/generations') else 92)).decode()}]}
            elif self.path == '/v1/chat/completions':
                state['review_calls'] += 1
                decision = state['decision']
                result = {'decision': decision, 'categories': ['political_cn'] if decision == 'blocked' else [], 'reason': '模拟审核'}
                result = {'choices': [{'message': {'content': json.dumps(result)}}]}
            elif self.path == '/v1/responses':
                state['generation'] += 1
                state['last'] = body
                if state['slow']:
                    time.sleep(3)
                prompt = body['input'][-1]['content'][0]['text']
                if prompt == 'bad-output':
                    result = {'id': 'bad', 'status': 'completed', 'output': [{'type': 'image_generation_call', 'result': 'invalid'}]}
                else:
                    result = {'id': f'resp_{state["generation"]}', 'status': 'completed', 'output': [
                        {'type': 'message', 'content': [{'type': 'output_text', 'text': '已生成图片'}]},
                        {'type': 'image_generation_call', 'result': base64.b64encode(png(40 + state['generation'])).decode()}]}
            else:
                self.send_error(404)
                return
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except BrokenPipeError:
                pass

    mock = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    mock.daemon_threads = False
    mock_thread = threading.Thread(target=mock.serve_forever)
    mock_thread.start()
    mock_port = mock.server_port
    log = (runtime / 'api.log').open('wb')
    def client():
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    admin, user, other, anonymous = [client() for _ in range(4)]
    def request(who, path, method='GET', body=None, expected=200, raw=False):
        nonlocal checks
        headers = {'Origin': base}
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        elif isinstance(body, bytes):
            headers['Content-Type'] = 'multipart/form-data; boundary=ai-test'
        try:
            response = who.open(urllib.request.Request(base + path, body, headers, method=method), timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        data = response.read()
        assert response.status == expected, (path, response.status, expected, data[:500])
        checks += 1
        return data if raw else json.loads(data) if data else None
    def upload(who, data, private=False, expected=201):
        body = b'--ai-test\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n' + data + b'\r\n--ai-test--\r\n'
        return request(who, '/api/v1/images' + ('?private=true' if private else ''), 'POST', body, expected)
    def poll(fn, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = fn()
            if predicate(value):
                return value
            time.sleep(.25)
        raise AssertionError(('poll timeout', value))
    def review(image):
        return poll(lambda: request(admin, '/api/v1/admin/reviews')['items'], lambda rows: any(r['image_id'] == image['id'] and r['status'] in ('passed', 'blocked', 'review', 'failed') for r in rows))
    def account():
        return request(user, '/api/v1/me')['user']
    def moderation(uid, exempt=False, action=None):
        request(admin, f'/api/v1/admin/users/{uid}/moderation', 'PATCH', {'exempt': exempt, 'action': action}, 204)
    def save(config):
        request(admin, '/api/v1/admin/ai', 'PATCH', config, 204)
    def conversation(who=user):
        return request(who, '/api/v1/ai/conversations', 'POST')['id']
    def send(cid, prompt, reference=None, expected=202):
        return request(user, f'/api/v1/ai/conversations/{cid}', 'POST', {'prompt': prompt, 'reference_id': reference}, expected)
    def finish(cid):
        return poll(lambda: request(user, f'/api/v1/ai/conversations/{cid}'), lambda rows: rows and rows[-1]['status'] in ('completed', 'failed'))[-1]
    def stop():
        nonlocal process
        if process is not None:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGINT)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            process = None
    def start():
        nonlocal process
        env = {**os.environ, 'DATABASE_URL': database, 'UPLOAD_DIR': str(uploads), 'PICCOVE_STORAGE_ROOTS': str(uploads),
               'PICCOVE_ADMIN_USERNAME': 'admin', 'PICCOVE_ADMIN_PASSWORD': 'ai-test-password-123',
               'CORS_ORIGIN': base, 'PUBLIC_BASE_URL': base, 'LISTEN_ADDR': f'127.0.0.1:{port}'}
        env.pop('PICCOVE_IMPORT_DIR', None)
        process = subprocess.Popen([os.environ['PICCOVE_AI_TEST_BINARY']], cwd=runtime, env=env, stdout=log, stderr=log, start_new_session=True)
        groups.append(process.pid)
        print(f'API PGID={process.pid} uid/gid={os.getuid()}:{os.getgid()} port={port}; mock port={mock_port}; cwd={runtime}', flush=True)
        for _ in range(100):
            assert process.poll() is None, (runtime / 'api.log').read_text()
            try:
                request(anonymous, '/api/health', raw=True)
                return
            except (OSError, urllib.error.URLError):
                time.sleep(.1)
        raise AssertionError('API startup timeout')

    try:
        start()
        request(admin, '/api/v1/auth/login', 'POST', {'username': 'admin', 'password': 'ai-test-password-123'})
        for name in ['tester', 'other']:
            request(admin, '/api/v1/admin/users', 'POST', {'username': name, 'password': 'ai-test-password-123'}, 201)
        request(user, '/api/v1/auth/login', 'POST', {'username': 'tester', 'password': 'ai-test-password-123'})
        request(other, '/api/v1/auth/login', 'POST', {'username': 'other', 'password': 'ai-test-password-123'})
        uid = account()['id']
        request(user, '/api/v1/admin/ai', expected=403)
        request(anonymous, '/api/v1/ai/conversations', expected=401)
        provider = {'base_url': f'http://127.0.0.1:{mock_port}/v1', 'key': 'test-secret', 'model': 'test-model'}
        config = {'generation': dict(provider), 'moderation': dict(provider), 'image_model': 'test-image', 'moderation_enabled': True, 'before_publish': False, 'daily_limit': 20, 'concurrent_limit': 1, 'ban_threshold': 2}
        save(config)
        if os.environ.get('PICCOVE_AI_TEST_RESILIENCE') == '1':
            state['decision'] = 'invalid-decision'
            failed_open = upload(user, png(20))
            config['before_publish'] = True
            save(config)
            failed_closed = upload(user, png(21))
            request(anonymous, f'/i/{failed_open["id"]}', raw=True)
            request(anonymous, f'/i/{failed_closed["id"]}', expected=404)
            rows = poll(lambda: request(admin, '/api/v1/admin/reviews')['items'], lambda rows: len(rows) == 2 and all(r['status'] == 'failed' for r in rows), timeout=75)
            assert all(r['attempts'] == 3 and not r['counted'] for r in rows)
            assert account()['violation_count'] == 0
            request(anonymous, f'/i/{failed_open["id"]}', raw=True)
            request(anonymous, f'/i/{failed_closed["id"]}', expected=404)
            state['decision'] = 'passed'
            for row in rows:
                request(admin, f'/api/v1/admin/reviews/{row["id"]}/retry', 'POST', expected=204)
            review(failed_open)
            review(failed_closed)
            request(anonymous, f'/i/{failed_closed["id"]}', raw=True)
            config['generation']['key'] = ''
            config['moderation']['key'] = ''
            save(config)
            assert request(admin, '/api/v1/admin/ai')['generation_key_set']
            cid = conversation()
            state['slow'] = True
            send(cid, 'restart while generating')
            poll(lambda: state['generation'], lambda count: count == 1)
            stop()
            start()
            row = finish(cid)
            assert row['status'] == 'failed' and '中断' in row['error']
            assert request(user, '/api/v1/ai/status')['used'] == 0
            assert state['generation'] == 1, 'Interrupted generation must not be sent upstream again'
            state['slow'] = False
            send(cid, 'manual retry')
            assert finish(cid)['status'] == 'completed'
            assert state['generation'] == 2
            print(f'PASS resilience: {checks} HTTP assertions; bounded review retries, error visibility, manual retry, secret retention, interrupted generation recovery.', flush=True)
            return
        read = request(admin, '/api/v1/admin/ai')
        assert read['generation']['key'] == read['moderation']['key'] == '' and read['generation_key_set']
        assert read['generation_mode'] == 'responses', 'Keep existing configurations on Responses'
        model_input = {'provider': 'generation', 'base_url': config['generation']['base_url'], 'key': ''}
        request(user, '/api/v1/admin/ai/models', 'POST', model_input, 403)
        assert request(admin, '/api/v1/admin/ai/models', 'POST', model_input) == ['chat-test', 'image-test']
        request(admin, '/api/v1/admin/ai/models', 'POST', {**model_input, 'base_url': f'http://127.0.0.1:{mock_port}/other'}, 400)
        assert request(admin, '/api/v1/admin/ai/models', 'POST', {**model_input, 'key': 'test-secret'}) == ['chat-test', 'image-test']
        direct = {**config, 'generation_mode': 'images', 'generation': {**config['generation'], 'model': '', 'key': ''}, 'image_model': 'image-test'}
        save(direct)
        assert request(user, '/api/v1/ai/status')['enabled']
        request(admin, '/api/v1/admin/ai', 'PATCH', {**direct, 'generation_mode': 'responses'}, 400)
        direct_cid = conversation(admin)
        for prompt, endpoint in [('direct', '/v1/images/generations'), ('edit direct', '/v1/images/edits')]:
            request(admin, f'/api/v1/ai/conversations/{direct_cid}', 'POST', {'prompt': prompt}, 202)
            rows = poll(lambda: request(admin, f'/api/v1/ai/conversations/{direct_cid}'), lambda rows: rows and rows[-1]['status'] in ('completed', 'failed'))
            assert rows[-1]['status'] == 'completed', rows[-1]
            assert state['last'] == endpoint
            assert request(admin, f'/i/{rows[-1]["image_id"]}', raw=True).startswith(b'\x89PNG')
        save(config)
        assert 'test-secret' not in json.dumps(request(anonymous, '/api/v1/settings'))
        large = png(1, large=True)
        image = upload(user, large)
        assert request(anonymous, f'/i/{image["id"]}', raw=True) == large
        review(image)
        request(anonymous, f'/api/v1/images/{image["id"]}/thumbnail', raw=True)
        state['decision'] = 'blocked'
        bad_bytes = png(2)
        bad1 = upload(user, bad_bytes)
        rows = review(bad1)
        rid = next(r['id'] for r in rows if r['image_id'] == bad1['id'])
        assert account()['violation_count'] == 1
        for who in [user, anonymous]:
            request(who, f'/i/{bad1["id"]}', expected=404)
            request(who, f'/api/v1/images/{bad1["id"]}/thumbnail', expected=404)
        assert request(admin, f'/i/{bad1["id"]}', raw=True) == bad_bytes
        upload(user, bad_bytes, expected=200)
        assert account()['violation_count'] == 1
        request(user, f'/api/v1/images/{bad1["id"]}', 'DELETE', expected=204)
        bad1b = upload(user, bad_bytes)
        assert bad1b['moderation_status'] == 'blocked' and account()['violation_count'] == 1
        bad2 = upload(user, png(3))
        review(bad2)
        assert account()['content_ban'] == 'auto' and account()['violation_count'] == 2
        config['ban_threshold'] = 5
        save(config)
        image_review = next(r for r in request(admin, '/api/v1/admin/reviews')['items'] if r['image_id'] == image['id'])
        request(admin, f'/api/v1/admin/reviews/{image_review["id"]}', 'PATCH', {'decision': 'blocked'}, 204)
        assert account()['violation_count'] == 3
        request(admin, f'/api/v1/admin/reviews/{image_review["id"]}', 'PATCH', {'decision': 'passed'}, 204)
        assert account()['content_ban'] == 'auto', 'Later violations must preserve original ban threshold'
        config['ban_threshold'] = 2
        save(config)
        upload(user, png(4), expected=403)
        request(user, f'/api/v1/images/{image["id"]}/visibility', 'PATCH', {'is_public': True}, 403)
        assert request(anonymous, f'/i/{image["id"]}', raw=True) == large
        request(admin, f'/api/v1/admin/reviews/{rid}', 'PATCH', {'decision': 'passed'}, 204)
        assert account()['content_ban'] is None and account()['violation_count'] == 1
        moderation(uid, action='ban')
        request(admin, f'/api/v1/admin/reviews/{rid}', 'PATCH', {'decision': 'passed'}, 204)
        assert account()['content_ban'] == 'manual'
        moderation(uid, exempt=True)
        assert account()['content_ban'] == 'manual'
        request(admin, f'/api/v1/admin/users/{uid}/moderation', 'PATCH', {'action': 'unban'}, 204)
        assert account()['moderation_exempt'], 'Ban actions must preserve whitelist'
        calls = state['review_calls']
        white = upload(user, png(5))
        assert white['moderation_status'] == 'exempt'
        assert state['review_calls'] == calls
        admin_image = upload(admin, png(6))
        assert admin_image['moderation_status'] == 'exempt'
        moderation(uid)
        state['decision'] = 'passed'
        config['before_publish'] = True
        save(config)
        pending = upload(user, png(7))
        request(anonymous, f'/i/{pending["id"]}', expected=404)
        request(user, f'/i/{pending["id"]}', raw=True)
        request(anonymous, f'/api/v1/images/{pending["id"]}/thumbnail', expected=404)
        review(pending)
        request(anonymous, f'/i/{pending["id"]}', raw=True)
        state['decision'] = 'review'
        uncertain = upload(user, png(8))
        review(uncertain)
        assert account()['violation_count'] == 1
        request(user, f'/i/{uncertain["id"]}', expected=404)
        state['decision'] = 'passed'
        cid = conversation()
        request(other, f'/api/v1/ai/conversations/{cid}', expected=404)
        request(other, f'/api/v1/ai/conversations/{cid}', 'POST', {'prompt': 'foreign'}, 404)
        send(cid, 'first', pending['id'])
        first = finish(cid)
        assert first['status'] == 'completed', first
        assert state['last']['input'][0]['content'][1]['image_url'].startswith('data:image/png;base64,')
        review({'id': first['image_id']})
        assert 'response_id' not in first
        request(anonymous, f'/i/{first["image_id"]}', expected=404)
        send(cid, 'change background')
        second = finish(cid)
        assert second['status'] == 'completed' and 'previous_response_id' not in state['last'] and state['last']['store'] is False
        assert state['last']['input'][0]['content'] == 'first'
        assert state['last']['input'][-1]['content'][1]['type'] == 'input_image'
        assert first['image_id'] != second['image_id']
        review({'id': second['image_id']})
        other_image = upload(other, png(9))
        send(cid, 'foreign image', other_image['id'], 404)
        config['daily_limit'] = 2
        save(config)
        send(cid, 'over quota', expected=400)
        config['daily_limit'] = 3
        save(config)
        send(cid, 'bad-output')
        failed = finish(cid)
        assert failed['status'] == 'failed'
        assert request(user, '/api/v1/ai/status')['used'] == 2
        state['slow'] = True
        send(cid, 'slow')
        send(cid, 'concurrent', expected=400)
        third = finish(cid)
        assert third['status'] == 'completed'
        review({'id': third['image_id']})
        state['slow'] = False
        config['daily_limit'] = 20
        save(config)
        state['decision'] = 'blocked'
        send(cid, 'generated violation')
        generated = finish(cid)
        assert generated['status'] == 'completed'
        review({'id': generated['image_id']})
        assert account()['violation_count'] == 2 and account()['content_ban'] == 'auto'
        request(user, f'/i/{generated["image_id"]}', expected=404)
        moderation(uid, action='unban')
        send(cid, 'reuse blocked context')
        assert finish(cid)['status'] == 'failed'
        stop()
        start()
        assert account()['violation_count'] == 2
        assert request(user, f'/api/v1/ai/conversations/{cid}')[-1]['status'] == 'failed'
        state['decision'] = 'invalid-decision'
        paused = upload(other, png(31))
        rows = poll(lambda: request(admin, '/api/v1/admin/reviews')['items'], lambda rs: any(r['image_id'] == paused['id'] and r['attempts'] == 1 for r in rs))
        config['moderation_enabled'] = False
        save(config)
        time.sleep(18)  # Cross the 15-second retry deadline and worker polling interval.
        paused_row = next(r for r in request(admin, '/api/v1/admin/reviews')['items'] if r['image_id'] == paused['id'])
        assert paused_row['attempts'] == 1 and paused_row['status'] == 'pending', 'Disabled moderation must pause pending jobs'
        state['decision'] = 'passed'
        config['moderation_enabled'] = True
        save(config)
        assert next(r for r in review(paused) if r['image_id'] == paused['id'])['status'] == 'passed'
        print(f'PASS: {checks} HTTP assertions; moderation, dedup ledger, bans, exemptions, visibility, conversations, editing, quota and restart persistence.', flush=True)
    finally:
        stop()
        mock.shutdown()
        mock.server_close()
        mock_thread.join(timeout=10)
        assert not mock_thread.is_alive()
        log.close()
        for pgid in groups:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                continue
            raise AssertionError(f'Process group still alive: {pgid}')
        for used_port in [port, mock_port]:
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(('127.0.0.1', used_port))
        shutil.rmtree(runtime)
        print(f'Cleanup: stopped PGIDs {groups}; released ports {port}/{mock_port}; removed {runtime}', flush=True)


if __name__ == '__main__':
    main()
