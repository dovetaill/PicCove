"""Create a new installation's configuration; never replace existing secrets."""
import argparse
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit


def configure(directory, origin, port, project, contact):
    url = urlsplit(origin)
    url.port  # Reject malformed or out-of-range URL ports before writing secrets.
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment or any(c in origin for c in '\r\n$\'"')):
        raise ValueError('origin 必须是完整 http(s) Origin，不含路径或末尾斜杠。')
    if url.scheme == 'http' and url.hostname not in ('127.0.0.1', 'localhost'):
        raise ValueError('公网部署必须使用 https Origin；本机试用可用 http://127.0.0.1:端口。')
    if not 1024 <= port <= 65535 or not re.fullmatch('[a-z][a-z0-9-]{0,39}', project):
        raise ValueError('端口须为 1024–65535，项目名须为小写字母开头的字母数字或连字符。')
    if contact and (not contact.startswith(('https://', 'mailto:')) or any(c in contact for c in '\r\n$\'"')):
        raise ValueError('联系地址须为 HTTPS 或 mailto 地址，不能包含换行和引号。')
    database = secrets.token_hex(24)
    admin = secrets.token_urlsafe(24)
    content = (f'COMPOSE_PROJECT_NAME={project}\nPICCOVE_ORIGIN={origin}\nPICCOVE_PORT={port}\n'
               f'DATABASE_PASSWORD={database}\nPICCOVE_ADMIN_PASSWORD={admin}\nCONTACT_URL={contact}\n')
    descriptor = os.open(directory / '.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(content)
    return admin


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--project', default='piccove')
    parser.add_argument('--contact', default='')
    args = parser.parse_args()
    try:
        configure(Path.cwd(), args.origin, args.port, args.project, args.contact)
        print('配置已写入 .env（权限 0600）。管理员初始密码保存在 PICCOVE_ADMIN_PASSWORD，不在日志中输出。')
    except (ValueError, FileExistsError) as error:
        raise SystemExit('配置失败（已有 .env 不会覆盖）：' + str(error))
