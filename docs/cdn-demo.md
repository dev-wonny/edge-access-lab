# CDN 캐시 실험

## 목표와 요청 경로

공개 SVG 파일을 반복 조회해 Cloudflare 캐시 HIT일 때 원본 요청이 줄어드는지 확인한다.
URL: `https://tunnel.devwonny.win/cdn-demo/cache-v1.svg`

- MISS: Cloudflare → 기존 Tunnel → 원본 서비스 → 이미지 응답을 캐시에 저장.
- HIT: Cloudflare가 캐시에서 응답. 원본의 Nginx/Python까지 요청을 전달하지 않는다.
- `/secure*`는 기존 Worker·Access 경로다. 이 데모는 해당 경로 밖에 있다.
- R2 객체 저장과 CDN HTTP 응답 캐싱은 별개다. 이 실험은 R2를 사용하지 않는다.

## Git으로 관리하는 범위

`origin/static/cdn-demo/cache-v1.svg`는 인증 정보가 없는 고정 공개 파일이다.
Python은 정확히 이 URL만 파일로 매핑한다. 사용자 URL을 파일 경로로 변환하지 않는다.
응답은 `public, max-age=60, s-maxage=300`: 브라우저 60초, 공유 캐시 300초의 신선도다.
실제 캐시 보존 기간은 퇴출이나 별도 Cloudflare 규칙에 따라 달라질 수 있다.
오류와 허용하지 않은 메서드는 `no-store`, 기존 헤더 조회 응답은 `private, no-store`다.
이미지가 변경되면 새 파일명과 허용 URL로 버전을 올리거나 해당 URL 캐시를 제거한다.

기존 `origin/**`, `tests/**` 변경 감지로 main 병합 시 Actions가 SSM 배포를 실행한다.
설치된 배포 스크립트가 후보 커밋 테스트 후 origin 변경을 감지하여 Python을 재시작한다.
추가된 배포 검사는 원본의 이미지 바이트와 캐시 헤더를 확인한다.
Nginx 참고용 설정이나 Certbot 인증서 설정을 덮어쓰지 않으며 수동 EC2 작업이 필요 없다.

## 로컬 검증

```bash
python3 -m unittest discover -s tests -v
```

## 배포 후 Mac에서 CDN 확인

아래 URL을 바꾸지 않고 여러 번 GET한다. `curl`은 브라우저 캐시를 사용하지 않는다.

```bash
for attempt in 1 2 3; do
  curl --fail --silent --show-error --max-time 15 \
    -D - -o /dev/null \
    -w 'TTFB=%{time_starttransfer}s total=%{time_total}s\n' \
    'https://tunnel.devwonny.win/cdn-demo/cache-v1.svg'
done
```

확인: HTTP 200, `Content-Type: image/svg+xml`, `CF-Cache-Status`, `Age`, `CF-Ray`.
캐시가 비어 있으면 MISS, 같은 캐시에서 다시 제공하면 HIT가 기대된다.
이미 다른 요청이 채웠으면 첫 요청도 HIT일 수 있고, 다른 데이터센터에서는 MISS일 수 있다.
`CF-Ray` 끝의 데이터센터 코드를 함께 기록한다. 1회 속도 차이만으로 개선을 단정하지 않는다.

CloudWatch의 Nginx access 로그에서 `/cdn-demo/cache-v1.svg`를 검색한다.
Tunnel이 Python에 직접 연결된 경우에는 Python 로그에서 확인한다.
동일 시간대에 MISS는 원본 기록이 생기고 HIT는 추가 원본 기록이 없는지 비교한다.
배포 원본 검사는 Python 로그에 별도로 남으므로 시간대를 구분한다.

## HIT가 나오지 않을 때

- JSON이면 정적 파일 배포 또는 요청 경로가 잘못된 것이다. 강제로 캐시하지 않는다.
- 302/로그인 화면이면 Access가 데모 경로까지 보호하는지 확인한다.
- `private`/`no-store`이면 원본이나 중간 프록시가 캐시 헤더를 바꾸는지 확인한다.
- Cloudflare Development Mode, 기존 Cache Rules의 Bypass, Set-Cookie 여부를 확인한다.
- `infiniteloopclub.cloud`의 DNS-only 경로는 이 실험 대상이 아니다.
- 전체 사이트 Cache Everything이나 개인화 응답의 캐시 강제 규칙을 추가하지 않는다.

공식 기준: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/

## 발표 증거

배포 성공 로그, 같은 URL의 MISS/HIT 헤더, 같은 시간대 원본 로그를 함께 캡처한다.
이 PR의 로컬 테스트는 응답 동작만 검증한다. 실제 Cloudflare HIT는 병합·배포 후 확인해야 한다.
