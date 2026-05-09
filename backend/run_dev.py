"""
开发环境启动入口：默认热重载，修改 main.py 后自动重载进程，避免旧进程缺少新路由导致 404。
用法（在 backend 目录）: ..\\venv\\Scripts\\python.exe run_dev.py
或从仓库根目录: backend\\venv\\Scripts\\python.exe backend\\run_dev.py
"""
import os
import sys

import uvicorn

if __name__ == "__main__":
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(backend_dir)
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8001,
        reload=True,
        reload_dirs=[backend_dir],
    )
