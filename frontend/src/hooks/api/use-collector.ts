import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { API_ENDPOINTS } from '@/lib/api/config';
import { queryKeys } from '@/lib/query/keys';

export interface CollectorBatch {
  id: string;
  kind: string;
  date: string;
  fetched_at: string;
  received_at: string;
  http_status: number;
  status: string;
  attempts: number;
  diagnostics: {
    code: string;
    counts?: Record<string, number>;
    detail?: string;
  };
}

interface CollectorStatus {
  connection_id: string | null;
  paired_at: string | null;
  last_received_at: string | null;
  public_url: string | null;
  setup_url: string | null;
  batches: CollectorBatch[];
}

export function useCollector(userId: string) {
  return useQuery({
    queryKey: queryKeys.collector(userId),
    queryFn: () =>
      apiClient.get<CollectorStatus>(API_ENDPOINTS.collectorStatus(userId)),
    refetchInterval: 30000,
  });
}

export function usePairCollector(userId: string) {
  return useMutation({
    mutationFn: () =>
      apiClient.post<{ code: string; expires_at: string }>(
        API_ENDPOINTS.collectorPair(userId)
      ),
  });
}

export function useReplayCollector(userId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) =>
      apiClient.post<CollectorBatch>(
        API_ENDPOINTS.collectorReplay(userId, batchId)
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.collector(userId) }),
  });
}
