import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { publicJson, requestJson } from './api';
import { consumerResponse } from './consumer-key';
import { useIdentity } from './identity-context';
import type {
  Attestation,
  BaseUrlGroup,
  Consumer,
  ConsumerUsage,
  LedgerRow,
  LoginResponse,
  Me,
  Pricing,
  ProtocolSchema,
  Provider,
  ProviderUsage,
  ModelCatalog,
  ModelList,
  RequestRow,
} from './types';

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

export function useProviders(enabled: boolean) {
  return useQuery({
    queryKey: ['providers'],
    enabled,
    retry: false,
    queryFn: () => requestJson<{ items: Provider[] }>({ path: '/api/v1/providers' }),
  });
}

/**
 * 接下来会打到的那条上游有哪些模型。
 *
 * 只有服务端能问：上游密钥在库里是密文，客户端不接触明文。所以这是一次转发面请求，
 * 带一条下游消费者 Token——**不指定上游**：哪一条由服务端按「自有优先、公共池兜底、
 * thread-id / session-id 粘住」自己挑，与真正发出去的那次转发是同一套判定。
 *
 * 它不扣费，所以取回来可以多放一会儿。
 */
export function useModels(enabled: boolean) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: ['models', identity.address],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const response = await consumerResponse({ address: identity.address, path: '/v1/models' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return (await response.json()) as ModelList;
    },
  });
}

/**
 * 账户的模型总表：所有启用中的上游提供商各自回了什么，并成一张表。
 *
 * 与数据面的 `/v1/models` 分工不同：那个一次只答一条上游、要一把下游 Token；
 * 这张表是资源视图，走签名，一次问完所有上游。它不扣费，所以取回来可以多放一会儿；
 * 也因为它会真的去打每条上游，页面加载时不主动重取，点「刷新」才再问一遍。
 */
export function useModelCatalog(enabled: boolean) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: ['model-catalog', identity.address],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => requestJson<ModelCatalog>({ path: '/api/v1/models' }),
  });
}

const PER_PAGE = 20;

/**
 * 请求记录：游标翻页。`cursor` 是上一页最后一行的 request_id
 * （UUID v7，字典序即时间序），undefined 表示第一页。
 *
 * 为什么不做「拉 200 行再本地切片」：那是旧 id（随机串）带来的权宜，
 * 账本一旦按 token 计价，行数增长得比请求数快，本地切片会先把流量撑爆。
 */
export function useUsage(enabled: boolean, cursor: string | undefined) {
  return useQuery({
    queryKey: ['usage', cursor ?? 'head'],
    enabled,
    retry: false,
    queryFn: () =>
      requestJson<{ items: RequestRow[] }>({
        path: `/api/v1/account/usage?limit=${PER_PAGE}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
      }),
    select: (data) => data.items,
  });
}

/** 记账流水：同样游标翻页，游标是 D1 的 rowid（这张表只追加，rowid 序即时间序）。 */
export function useLedger(enabled: boolean, cursor: number | undefined) {
  return useQuery({
    queryKey: ['ledger', cursor ?? 'head'],
    enabled,
    retry: false,
    queryFn: () =>
      requestJson<{ items: LedgerRow[] }>({
        path: `/api/v1/account/ledger?limit=${PER_PAGE}${cursor ? `&cursor=${cursor}` : ''}`,
      }),
    select: (data) => data.items,
  });
}

/** 按下游消费者密钥聚合的用量：账本要能回答「这把钥匙花了多少」。 */
export function useUsageByConsumer(enabled: boolean) {
  return useQuery({
    queryKey: ['usage-by-consumer'],
    enabled,
    retry: false,
    queryFn: () => requestJson<{ items: ConsumerUsage[] }>({ path: '/api/v1/account/usage/by-consumer' }),
    select: (data) => data.items,
  });
}

/** 按上游提供商聚合的用量：钱花在哪个上游提供商。 */
export function useUsageByProvider(enabled: boolean) {
  return useQuery({
    queryKey: ['usage-by-provider'],
    enabled,
    retry: false,
    queryFn: () => requestJson<{ items: ProviderUsage[] }>({ path: '/api/v1/account/usage/by-provider' }),
    select: (data) => data.items,
  });
}

/** 协议清单：新建上游时「先选协议、再按协议渲染字段」的依据（公开、随代码发布）。 */
export function useProtocols() {
  return useQuery({
    queryKey: ['protocols'],
    staleTime: 300_000,
    queryFn: () => publicJson<{ items: ProtocolSchema[] }>('/api/v1/protocols'),
    select: (data) => data.items,
  });
}

/** 公开价目表：账本旁边要能查到「这个价是怎么算出来的」。 */
export function usePricing() {
  return useQuery({
    queryKey: ['pricing'],
    staleTime: 300_000,
    queryFn: () => publicJson<Pricing>('/api/v1/pricing'),
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

export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      requestJson<{ id: string }>({ path: '/api/v1/providers', method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useUpdateProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      requestJson<{ id: string }>({ path: `/api/v1/providers/${id}`, method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['base-urls'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useSetVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, publicListed }: { id: string; publicListed: boolean }) =>
      requestJson<{ id: string; public_listed: number }>({
        path: `/api/v1/providers/${id}/visibility`,
        method: 'POST',
        body: JSON.stringify({ public_listed: publicListed }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['base-urls'] });
    },
  });
}

/**
 * 把一条自己的上游放进 / 拿回公共池。服务端只认站点地址，别的账户会拿到 403——
 * 池子里的密钥是站点付钱，谁都不该替它决定这件事。
 */
export function useSetScope() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scope }: { id: string; scope: 'private' | 'pool' }) =>
      requestJson<{ id: string; scope: string }>({
        path: `/api/v1/providers/${id}/scope`,
        method: 'POST',
        body: JSON.stringify({ scope }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['model-catalog'] });
    },
  });
}

export function useSetEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      requestJson<{ id: string; enabled: number }>({
        path: `/api/v1/providers/${id}/enabled`,
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['base-urls'] });
    },
  });
}

export function useRevokeProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requestJson<{ id: string; revoked: boolean }>({ path: `/api/v1/providers/${id}`, method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['base-urls'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export { PER_PAGE };
