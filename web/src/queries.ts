import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson, publicJson } from './api';
import type { Attestation, BaseUrlGroup, Consumer, Credential, LedgerRow, LoginResponse, Me, RequestRow } from './types';

/** 登录：签名走通一次即开户。没有 body，签的是空字节串的 sha256。 */
export function useLogin(enabled: boolean, address: string) {
  return useQuery({
    // 地址进 key：导入种子换身份后必须重新登录，不能复用上一个账号的结果。
    queryKey: ['login', address],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: () => requestJson<LoginResponse>({ path: '/api/v1/auth/login', method: 'POST' }),
  });
}

export function useMe(enabled: boolean) {
  return useQuery({
    queryKey: ['me'],
    enabled,
    retry: false,
    queryFn: () => requestJson<Me>({ path: '/api/v1/account/me' }),
  });
}

export function useCredentials(enabled: boolean) {
  return useQuery({
    queryKey: ['credentials'],
    enabled,
    retry: false,
    queryFn: () => requestJson<{ items: Credential[] }>({ path: '/api/v1/credentials' }),
  });
}

const PER_PAGE = 20;

/**
 * 请求记录。后端只支持 limit（无 cursor），所以按「取到当前页末行为止」抓取，
 * 再在本地切片；上限 200 行与后端一致。这样 20 行一页的交互在真实数据量下也成立。
 */
export function useUsage(enabled: boolean, page: number) {
  const need = Math.min(PER_PAGE * (page + 1), 200);
  return useQuery({
    queryKey: ['usage', need],
    enabled,
    retry: false,
    queryFn: () => requestJson<{ items: RequestRow[] }>({ path: `/api/v1/account/usage?limit=${need}` }),
    select: (data) => data.items.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE),
  });
}

export function useLedger(enabled: boolean, page: number) {
  const need = Math.min(PER_PAGE * (page + 1), 200);
  return useQuery({
    queryKey: ['ledger', need],
    enabled,
    retry: false,
    queryFn: () => requestJson<{ items: LedgerRow[] }>({ path: `/api/v1/account/ledger?limit=${need}` }),
    select: (data) => data.items.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE),
  });
}

export function useConsumers(enabled: boolean) {
  return useQuery({
    queryKey: ['consumers'],
    enabled,
    retry: false,
    queryFn: () => requestJson<{ items: Consumer[] }>({ path: '/api/v1/consumers' }),
  });
}

export function useCreateConsumer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) =>
      requestJson<{ id: string; name: string; key: string; key_hint: string }>({
        path: '/api/v1/consumers',
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['consumers'] }),
  });
}

/** 轮换与新建一样，明文只在响应里出现一次。 */
export function useRotateConsumer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      requestJson<{ id: string; key: string; key_hint: string }>({ path: `/api/v1/consumers/${id}/rotate`, method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['consumers'] }),
  });
}

export function useRenameConsumer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      requestJson<{ id: string; name: string }>({ path: `/api/v1/consumers/${id}/name`, method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['consumers'] }),
  });
}

export function useRevokeConsumer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      requestJson<{ id: string; revoked: boolean }>({ path: `/api/v1/consumers/${id}`, method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['consumers'] }),
  });
}

export function useBaseUrls() {
  return useQuery({
    queryKey: ['base-urls'],
    queryFn: () => publicJson<{ items: BaseUrlGroup[] }>('/api/v1/base-urls'),
    select: (data) => data.items,
  });
}

export function useAttestation() {
  return useQuery({
    queryKey: ['attestation'],
    queryFn: () => publicJson<Attestation>('/api/v1/attestation'),
  });
}

export function useCreateCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      requestJson<{ id: string }>({ path: '/api/v1/credentials', method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useSetVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, publicListed }: { id: string; publicListed: boolean }) =>
      requestJson<{ id: string; public_listed: number }>({
        path: `/api/v1/credentials/${id}/visibility`,
        method: 'POST',
        body: JSON.stringify({ public_listed: publicListed }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      void queryClient.invalidateQueries({ queryKey: ['base-urls'] });
    },
  });
}

export function useRevokeCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requestJson<{ id: string; revoked: boolean }>({ path: `/api/v1/credentials/${id}`, method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      void queryClient.invalidateQueries({ queryKey: ['base-urls'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export { PER_PAGE };
