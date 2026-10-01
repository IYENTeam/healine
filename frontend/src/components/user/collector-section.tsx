import {
  useCollector,
  usePairCollector,
  useReplayCollector,
} from '@/hooks/api/use-collector';
import { Button } from '@/components/ui/button';
import { copyToClipboard } from '@/lib/utils/clipboard';

const names: Record<string, string> = {
  heart_rate: '심박',
  activity: '활동·걸음',
  sleep: '수면',
  recovery: '회복',
};
const reasons: Record<string, string> = {
  ok: '저장 완료',
  partial: '일부 유효하지 않은 샘플 제외',
  no_days: 'Polar 응답에 해당 날짜 없음',
  no_samples: '날짜는 있으나 상세 샘플 없음',
  invalid_samples: '샘플의 값·시간 형식 확인 필요',
  unexpected_schema: '응답 구조 확인 필요',
  http_error: 'Polar 조회 실패',
  processing_error: '재처리 대기',
};

function localTime(value: string) {
  return new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

export function CollectorSection({ userId }: { userId: string }) {
  const status = useCollector(userId);
  const pairing = usePairCollector(userId);
  const replay = useReplayCollector(userId);
  const data = status.data;
  const rows = (data?.batches ?? [])
    .filter(
      (batch, index, all) =>
        all.findIndex(
          (other) => other.date === batch.date && other.kind === batch.kind
        ) === index
    )
    .slice(0, 16);
  const setup = data?.setup_url ? new URL(data.setup_url) : null;
  if (setup) {
    setup.searchParams.set('platform_setup', '1');
    if (data?.public_url)
      setup.searchParams.set('platform_url', data.public_url);
  }

  return (
    <section className="rounded-2xl border border-border/60 bg-card p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Polar 수집기 · 캘린더 연결</h2>
          <p className="text-sm text-muted-foreground">
            {data?.last_received_at
              ? `마지막 수신: ${localTime(data.last_received_at)}`
              : data?.paired_at
                ? '연결됨 · 첫 데이터 수신 대기'
                : '기존 수집기를 Healine에 연결하세요.'}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={pairing.isPending || !setup || !data?.public_url}
          onClick={() => pairing.mutate()}
        >
          {pairing.isPending ? '발급 중…' : '연결 코드 발급'}
        </Button>
      </div>
      {status.isPending && (
        <p className="text-sm text-muted-foreground">수집 상태 확인 중…</p>
      )}
      {(status.error || pairing.error || replay.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(status.error || pairing.error || replay.error)?.message}
        </p>
      )}
      {data && (!data.public_url || !setup) && (
        <p className="text-sm text-muted-foreground">
          운영 서버의 HTTPS 주소와 기존 캘린더 연결 주소를 먼저 설정해야 합니다.
        </p>
      )}
      {pairing.data && setup && (
        <div className="rounded-lg bg-muted p-4 space-y-3">
          <p className="text-sm">
            코드를 복사하고 연결 화면에 붙여넣으세요. 기존 Polar 인증은
            유지됩니다.
          </p>
          <p className="text-sm">연결할 서버: {data?.public_url}</p>
          <p className="text-xs text-muted-foreground">
            코드 만료: {localTime(pairing.data.expires_at)}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                copyToClipboard(pairing.data.code, '연결 코드를 복사했습니다.')
              }
            >
              코드 복사
            </Button>
            <Button asChild>
              <a
                href={setup.toString()}
                target="_blank"
                rel="noopener noreferrer"
              >
                연결 화면 열기
              </a>
            </Button>
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-2">날짜·항목</th>
                <th>수집 결과</th>
                <th>관측 수</th>
                <th>조회 시각</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((batch) => (
                <tr key={batch.id} className="border-b last:border-0">
                  <td className="py-3 pr-3 whitespace-nowrap">
                    {batch.date}
                    <br />
                    {names[batch.kind] ?? batch.kind}
                  </td>
                  <td className="pr-3">
                    {reasons[batch.diagnostics.code] ?? batch.status}
                    {batch.http_status !== 200 && ` (${batch.http_status})`}
                  </td>
                  <td className="pr-3">
                    {batch.diagnostics.counts
                      ? Object.values(batch.diagnostics.counts).reduce(
                          (sum, count) => sum + count,
                          0
                        )
                      : '—'}
                  </td>
                  <td className="pr-3 whitespace-nowrap text-xs">
                    {localTime(batch.fetched_at)}
                  </td>
                  <td>
                    {['parse_error', 'processing_error'].includes(
                      batch.status
                    ) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={replay.isPending}
                        onClick={() => replay.mutate(batch.id)}
                      >
                        저장한 응답 재처리
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        원본 응답과 수신 이력을 보관합니다. 관측 수 0은 측정값이 0이라는 뜻이
        아닙니다.
      </p>
    </section>
  );
}
