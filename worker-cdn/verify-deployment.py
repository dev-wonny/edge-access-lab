"""배포 후 두 공개 Route의 실제 PNG 응답을 확인한다. 인증 토큰은 필요 없다."""

import time
import urllib.request


URLS = (
    "https://infiniteloopclub.cloud/cdn/KR.png",
    "https://tunnel.devwonny.win/cdn/KR.png",
)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def validate_response(status, headers, body):
    # 200 JSON도 실패로 처리한다. 확장자나 상태 코드만으로 성공 판단하지 않는다.
    if status != 200:
        raise ValueError(f"HTTP {status}")
    if headers.get_content_type() != "image/png":
        raise ValueError(f"PNG가 아닌 응답: {headers.get('Content-Type')}")
    if not body.startswith(PNG_SIGNATURE):
        raise ValueError("PNG 파일 시그니처가 없음")
    if headers.get("X-Demo-Cache") not in {"HIT", "MISS"}:
        raise ValueError(f"Worker 캐시 상태 확인 필요: {headers.get('X-Demo-Cache')}")


def main():
    for url in URLS:
        # Route 전파 시간을 고려하되, 실패를 성공으로 숨기지 않는다.
        for attempt in range(1, 7):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "edge-access-lab-deploy-check"})
                with urllib.request.urlopen(request, timeout=15) as response:
                    validate_response(response.status, response.headers, response.read(8))
                    print(f"OK {url}: image/png, X-Demo-Cache={response.headers.get('X-Demo-Cache')}")
                break
            except (OSError, ValueError) as error:
                print(f"확인 {attempt}/6 {url}: {error}")
                if attempt == 6:
                    raise SystemExit("배포 후 검증 실패. Route, DNS Proxied, R2 KR.png, 기존 JSON 캐시를 확인하세요.") from error
                time.sleep(5)


if __name__ == "__main__":
    main()
