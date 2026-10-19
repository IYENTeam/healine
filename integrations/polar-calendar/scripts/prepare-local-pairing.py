"""Create a private, one-use pairing handoff using the configured local administrator.

Run from the repository root with backend/.venv/bin/python. Credentials remain in
memory; stdout contains only the resulting local HTML path. Rerun if the code expires.
"""

import html
import os
from pathlib import Path
from urllib.parse import urlencode

import httpx
from dotenv import dotenv_values


def main() -> None:
    repository = Path(__file__).resolve().parents[3]
    config = dotenv_values(repository / "backend/config/.env")
    public_url = config.get("COLLECTOR_PUBLIC_URL")
    setup_url = config.get("COLLECTOR_SETUP_URL")
    if not public_url or not public_url.startswith("https://") or not setup_url:
        raise SystemExit("Configure COLLECTOR_PUBLIC_URL and COLLECTOR_SETUP_URL first.")
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=30) as client:
        response = client.post(
            "/api/v1/auth/login",
            data={"username": config["ADMIN_EMAIL"], "password": config["ADMIN_PASSWORD"]},
        )
        response.raise_for_status()
        client.headers["Authorization"] = "Bearer " + response.json()["access_token"]
        response = client.get("/api/v1/users", params={"email": config["ADMIN_EMAIL"]})
        response.raise_for_status()
        users = response.json()["items"]
        if users:
            user_id = users[0]["id"]
        else:
            response = client.post("/api/v1/users", json={"email": config["ADMIN_EMAIL"], "first_name": "Healine"})
            response.raise_for_status()
            user_id = response.json()["id"]
        response = client.post(f"/api/v1/users/{user_id}/collectors/polar-v4/pair")
        response.raise_for_status()
        pairing = response.json()
    destination = setup_url + "?" + urlencode({"platform_setup": "1", "platform_url": public_url})
    temporary = "임시 검증 주소입니다. 운영 시 고정 주소로 연결해야 합니다." if public_url.endswith(".trycloudflare.com") else ""
    page = f"""<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Healine 연결</title>
<style>body{{max-width:650px;margin:60px auto;padding:24px;font:17px/1.7 system-ui;background:#f5f8f7;color:#18342b}}
input{{box-sizing:border-box;width:100%;padding:12px;font:15px monospace}}button{{padding:12px 20px;margin-top:20px;font:inherit}}
small{{color:#50665e}}a{{color:#185e42}}</style>
<h1>기존 Polar 수집기를 Healine에 연결</h1>
<p>아래 버튼으로 코드를 복사하고 Google 연결 화면을 여세요. 그 화면의 연결 코드 칸에 붙여넣은 뒤 <b>이 서버에 연결</b>을 누르면 됩니다.</p>
<p>수집한 건강 데이터는 이 Mac의 Healine에 저장됩니다. 기존 Polar 인증과 캘린더는 그대로 사용합니다.</p>
<small>서버: {html.escape(public_url)}<br>{temporary}<br>발급 후 15분간 한 번만 사용할 수 있습니다.</small>
<input id="code" readonly aria-label="일회용 연결 코드" value="{html.escape(pairing['code'], quote=True)}">
<button id="connect">코드 복사하고 Google 연결 화면 열기</button>
<p id="message"></p><p><a id="destination" href="{html.escape(destination, quote=True)}">Google 연결 화면 직접 열기</a></p>
<script>document.getElementById('connect').onclick=function(){{
var input=document.getElementById('code');input.focus();input.select();
if(document.execCommand('copy')){{window.location.href=document.getElementById('destination').href;}}
else{{document.getElementById('message').textContent='선택된 코드를 직접 복사하고 아래 링크를 여세요.';}}
}};</script></html>"""
    state = Path.home() / ".local/state/healine"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    handoff = state / "connect.html"
    with os.fdopen(os.open(handoff, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        stream.write(page)
    handoff.chmod(0o600)
    print(handoff)


if __name__ == "__main__":
    main()
