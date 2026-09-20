// Worker의 로그에 서비스·런타임·시각·심각도를 공통으로 붙인다.
// fields는 호출한 쪽이 전달한 event, requestId, stage 등 로그 내용이다.
function emit(level, fields) {
  const entry = {
    ...fields,
    // 고정 식별자를 뒤에 넣어 fields에 같은 이름이 있어도 덮어쓰지 못하게 한다.
    service: "edge-access-lab-worker",
    // JavaScript 코드지만 실행 환경은 Node.js 서버가 아닌 Cloudflare Workers다.
    runtime: "cloudflare-workers",
    component: "edge",
    // 로그 발생 시각을 UTC로 기록한다.
    timestamp: new Date().toISOString(),
    level,
  };
  // 심각도에 따라 콘솔 함수를 고른다. Cloudflare 로그 또는 wrangler tail에서 조회한다.
  const output = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  // 한 줄 JSON으로 출력한다. 이 함수가 CloudWatch로 보내는 것은 아니다.
  output(JSON.stringify(entry));
}

// 사용 예: log.info({ event: "authentication_verified", pathname: "/secure" })
export const log = {
  info: (fields) => emit("INFO", fields),
  warn: (fields) => emit("WARN", fields),
  error: (fields) => emit("ERROR", fields),
};
