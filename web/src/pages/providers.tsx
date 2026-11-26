import { PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import {
  useCreateProvider,
  useExchangeOAuth,
  useProtocols,
  useProviders,
  useRevokeProvider,
  useSetEnabled,
  useSetScope,
  useStartOAuth,
  useUpdateProvider,
} from '../queries';
import type { Provider } from '../types';
import { protocolLabel } from '../lib/labels';

export function ProvidersPage() {
  const { t, lang } = useI18n();
  const providers = useProviders(true);
  const setEnabled = useSetEnabled();
  const setScope = useSetScope();
  const revoke = useRevokeProvider();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const items = providers.data?.items ?? [];
  // 「公开」只有一个开关：进公共池。能不能拨它由站点地址清单决定，前端只负责置灰。
  const canOwnPool = providers.data?.can_own_pool === true;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('pr.title')}
        description={t('pr.desc')}
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <PlusIcon />
            {t('action.new_provider')}
          </Button>
        }
      />

      <Section bodyClassName="p-0">
        {providers.isPending ? (
          <SkeletonRows rows={4} cols={5} />
        ) : providers.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(providers.error as Error).message} />
          </div>
        ) : items.length === 0 ? (
          <Empty className="border-0">{t('pr.empty')}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pr.col_label')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('pr.col_base_url')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('pr.col_protocol')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('pr.col_hint')}</TableHead>
                <TableHead>{t('pr.col_enabled')}</TableHead>
                <TableHead>{t('pr.col_pool')}</TableHead>
                <TableHead className="text-right">{t('pr.col_actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <ProviderRow
                  key={item.id}
                  item={item}
                  confirming={confirmId === item.id}
                  canOwnPool={canOwnPool}
                  onConfirm={(value) => setConfirmId(value ? item.id : null)}
                  onEdit={() => setEditing(item)}
                  onToggleEnabled={(value) => setEnabled.mutate({ id: item.id, enabled: value })}
                  onTogglePool={(value) => setScope.mutate({ id: item.id, scope: value ? 'pool' : 'private' })}
                  onRevoke={() => {
                    revoke.mutate(item.id, { onSettled: () => setConfirmId(null) });
                  }}
                  lang={lang}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {setEnabled.isError ? <ErrorNote title={t('common.error')} message={(setEnabled.error as Error).message} /> : null}
      {setScope.isError ? <ErrorNote title={t('common.error')} message={(setScope.error as Error).message} /> : null}
      {revoke.isError ? <ErrorNote title={t('common.error')} message={(revoke.error as Error).message} /> : null}

      <NewProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => {
          setDialogOpen(false);
        }}
      />

      {/* 以 key 重挂载：换一条就重新读一次已保存的配置，不残留上一条的草稿。 */}
      {editing ? <EditProviderDialog key={editing.id} provider={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function ProviderRow({
  item,
  lang,
  confirming,
  canOwnPool,
  onConfirm,
  onEdit,
  onToggleEnabled,
  onTogglePool,
  onRevoke,
}: {
  item: Provider;
  lang: 'zh' | 'en';
  confirming: boolean;
  canOwnPool: boolean;
  onConfirm: (value: boolean) => void;
  onEdit: () => void;
  onToggleEnabled: (value: boolean) => void;
  onTogglePool: (value: boolean) => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();

  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="flex flex-wrap items-center gap-1.5">
          {item.label}
          {/* 池子里那条不是这个账户的资源：标出来，并且不给任何开关。 */}
          {item.mine ? null : (
            <Badge variant="outline" className="font-normal">
              {t('pr.scope_readonly')}
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell className="hidden max-w-64 lg:table-cell">
        <span className="block truncate font-mono text-xs text-muted-foreground" title={item.base_url}>
          {item.base_url}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Badge variant="outline" className="font-normal">
          {protocolLabel(item.protocol, lang)}
        </Badge>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <code className="text-xs">{item.key_hint}</code>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch
            checked={item.enabled === 1}
            onCheckedChange={onToggleEnabled}
            disabled={!item.mine}
            aria-label={t('pr.col_enabled')}
          />
          <span className="hidden text-[11px] whitespace-nowrap text-muted-foreground xl:inline">
            {item.enabled === 1 ? t('pr.enabled_on') : t('pr.enabled_off')}
          </span>
        </div>
      </TableCell>
      <TableCell>
        {/* 「公开」只有一个意思：进公共池。能拨它的只有站点地址，别人看到的是置灰的现状。 */}
        <div className="flex items-center gap-2">
          <Switch
            checked={item.scope === 'pool'}
            onCheckedChange={onTogglePool}
            disabled={!item.mine || !canOwnPool}
            aria-label={t('pr.col_pool')}
            title={item.mine && !canOwnPool ? t('pr.pool_admin_only') : undefined}
          />
          <span className="hidden text-[11px] whitespace-nowrap text-muted-foreground xl:inline">
            {item.scope === 'pool' ? t('pr.pool_on') : t('pr.pool_off')}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right">
        {item.mine ? (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={onEdit}>
              {t('action.edit')}
            </Button>
            <Button
              variant={confirming ? 'destructive' : 'ghost'}
              size="sm"
              className="whitespace-nowrap"
              onClick={() => (confirming ? onRevoke() : onConfirm(true))}
            >
              {confirming ? t('action.revoke_confirm') : t('action.revoke')}
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * 「连接」这一步：OpenAI OAuth 的凭据不是一把能贴的 API key，而是一对会过期的令牌。
 *
 * 两步手势（与那批走 Codex 的客户端一致）：点开授权页 → 登录 → 浏览器停在
 * `http://localhost:1455/auth/callback?code=…`（那台机器上没有服务在听，页面是打不开的，
 * 但地址栏里已经有 code）→ 把整行贴回来。PKCE 的 verifier 与 state 只活在这个组件的状态里：
 * 服务端不存流程表，换币时再由这里送回去。state 对不上就不换——那是「这次回调不是为这次
 * 授权来的」唯一一条可判的信号。
 */
function OAuthConnect({ onConnected }: { onConnected: (providerKey: string) => void }) {
  const { t } = useI18n();
  const start = useStartOAuth();
  const exchange = useExchangeOAuth();
  const [flow, setFlow] = useState<{ verifier: string; state: string } | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openAuthorize = async () => {
    setError(null);
    setAccountId(null);
    try {
      const started = await start.mutateAsync();
      setFlow({ verifier: started.verifier, state: started.state });
      // 新标签页打开：verifier 必须留在这个对话框里，所以不能就地跳转。
      window.open(started.authorize_url, '_blank', 'noopener');
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const finish = async () => {
    setError(null);
    if (flow === null) {
      setError(t('pr.oauth_need_start'));
      return;
    }
    let code = '';
    let state = '';
    try {
      const url = new URL(callbackUrl.trim());
      code = url.searchParams.get('code') ?? '';
      state = url.searchParams.get('state') ?? '';
    } catch {
      setError(t('pr.oauth_url_invalid'));
      return;
    }
    if (!code) {
      setError(t('pr.oauth_url_invalid'));
      return;
    }
    if (state !== flow.state) {
      setError(t('pr.oauth_state_mismatch'));
      return;
    }
    try {
      const result = await exchange.mutateAsync({ code, verifier: flow.verifier });
      setAccountId(result.account_id);
      onConnected(result.provider_key);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t('pr.field_key')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void openAuthorize()} disabled={start.isPending}>
          {start.isPending ? t('pr.oauth_starting') : t('pr.oauth_start')}
        </Button>
        {accountId ? (
          <span className="text-xs text-muted-foreground">{t('pr.oauth_connected', { account: accountId })}</span>
        ) : null}
      </div>
      {flow === null ? null : (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.oauth_hint')}</p>
          <Input
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
            placeholder={t('pr.oauth_paste_placeholder')}
            spellCheck={false}
          />
          <div>
            <Button size="sm" onClick={() => void finish()} disabled={exchange.isPending || callbackUrl.trim() === ''}>
              {exchange.isPending ? t('pr.oauth_finishing') : t('pr.oauth_finish')}
            </Button>
          </div>
        </>
      )}
      {error ? <ErrorNote message={error} /> : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.oauth_credential_hint')}</p>
    </div>
  );
}

/**
 * 新建上游：**先选协议**，字段跟着协议走，最后才是「是否公开」。
 *
 * 「Base URL + API key」是协议的一部分，不是两个可以自由组合的输入框：通用的四条方言
 * 要你填自己的上游地址，`deepseek` 的地址是官方固定值、只要密钥。字段集合由
 * `GET /api/v1/protocols` 给出，前端不留第二份判断。
 */
function NewProviderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onCreated: () => void;
}) {
  const { t, lang } = useI18n();
  const create = useCreateProvider();
  const protocols = useProtocols();

  const [protocol, setProtocol] = useState<string>('openai-chat');
  const [providerKey, setProviderKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const schemas = protocols.data ?? [];
  const schema = schemas.find((item) => item.protocol === protocol) ?? null;
  const asksBaseUrl = schema?.fields.includes('base_url') === true;

  const reset = () => {
    setLabel('');
    setProviderKey('');
    setBaseUrl('');
    setEnabled(true);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!label.trim() || !providerKey.trim() || (asksBaseUrl && !baseUrl.trim())) {
      setError(t('pr.missing'));
      return;
    }
    try {
      // 明文密钥这一次经过请求体，服务端立刻用 Worker secret 封装，之后只剩提示。
      // base_url 只在协议要的时候才发：固定基址的协议不接受另一个地址。
      await create.mutateAsync({
        label: label.trim(),
        provider_key: providerKey.trim(),
        protocol,
        enabled,
        ...(asksBaseUrl ? { base_url: baseUrl.trim() } : {}),
      });
      reset();
      onCreated();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pr.new_title')}</DialogTitle>
          <DialogDescription>{t('pr.new_desc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('pr.field_protocol')}</Label>
            <Select
              value={protocol}
              onValueChange={(value) => setProtocol(String(value))}
              items={schemas.map((item) => ({ value: item.protocol, label: protocolLabel(item.protocol, lang) }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {schemas.map((item) => (
                  <SelectItem key={item.protocol} value={item.protocol}>
                    {protocolLabel(item.protocol, lang)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_protocol_hint')}</p>
          </div>

          {protocols.isError ? <ErrorNote message={(protocols.error as Error).message} /> : null}

          {/* 协议 contextual 的一段：选完协议才存在，`deepseek` 与通用方言在这里分岔。 */}
          {schema === null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.protocol_loading')}</p>
          ) : (
            <>
              {asksBaseUrl ? (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('pr.field_base_url')}</Label>
                  <Input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder={t('pr.field_base_url_placeholder')}
                    spellCheck={false}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_base_url_hint')}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('pr.field_base_url')}</Label>
                  <p className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all">
                    {schema.base_url}
                  </p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t('pr.field_base_url_fixed', { protocol: protocolLabel(protocol, lang) })}
                  </p>
                </div>
              )}

              {schema.oauth ? (
                <OAuthConnect onConnected={setProviderKey} />
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('pr.field_key')}</Label>
                  <Input
                    type="password"
                    value={providerKey}
                    onChange={(event) => setProviderKey(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_key_hint')}</p>
                </div>
              )}

              {schema.stream_only ? (
                <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.stream_only_hint')}</p>
              ) : null}
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>{t('pr.field_label')}</Label>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('pr.field_label_placeholder')} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t('pr.field_enabled')}</Label>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_enabled_hint')}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t('pr.field_enabled')} />
          </div>

          {error ? <ErrorNote message={error} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || schema === null}>
            {create.isPending ? t('pr.creating') : t('action.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 编辑一条上游：表单读的是已保存的配置，密钥只以提示的形式露一半。
 *
 * 两个刻意的约束：密钥留空 = 保持原密文（它只能被替换，不能被读出来）；基址仍由协议
 * 决定——固定基址的协议不给输入框，从固定基址换到通用协议时清掉厂商地址，让用户自己填。
 */
function EditProviderDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const { t, lang } = useI18n();
  const update = useUpdateProvider();
  const protocols = useProtocols();

  const [label, setLabel] = useState(provider.label);
  const [protocol, setProtocol] = useState<string>(provider.protocol);
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [enabled, setEnabled] = useState(provider.enabled === 1);
  const [providerKey, setProviderKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const schemas = protocols.data ?? [];
  const schema = schemas.find((item) => item.protocol === protocol) ?? null;
  const asksBaseUrl = schema?.fields.includes('base_url') === true;

  const changeProtocol = (value: string) => {
    const previous = schemas.find((item) => item.protocol === protocol);
    const next = schemas.find((item) => item.protocol === value);
    setProtocol(value);
    // 厂商给的地址不该被当成用户自己的上游：换到通用协议时清空，强迫重新填一次。
    if (next?.fields.includes('base_url') && previous?.base_url && baseUrl === previous.base_url) {
      setBaseUrl('');
    }
  };

  const submit = async () => {
    setError(null);
    if (!label.trim() || (asksBaseUrl && !baseUrl.trim())) {
      setError(t('pr.missing'));
      return;
    }
    try {
      const body: Record<string, unknown> = {
        label: label.trim(),
        protocol,
        enabled,
      };
      if (asksBaseUrl) body.base_url = baseUrl.trim();
      if (providerKey.trim()) body.provider_key = providerKey.trim();
      await update.mutateAsync({ id: provider.id, body });
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pr.edit_title')}</DialogTitle>
          <DialogDescription>{t('pr.edit_desc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('pr.field_protocol')}</Label>
            <Select
              value={protocol}
              onValueChange={(value) => changeProtocol(String(value))}
              items={schemas.map((item) => ({ value: item.protocol, label: protocolLabel(item.protocol, lang) }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {schemas.map((item) => (
                  <SelectItem key={item.protocol} value={item.protocol}>
                    {protocolLabel(item.protocol, lang)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_protocol_hint')}</p>
          </div>

          {protocols.isError ? <ErrorNote message={(protocols.error as Error).message} /> : null}

          {schema === null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.protocol_loading')}</p>
          ) : (
            <>
              {asksBaseUrl ? (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('pr.field_base_url')}</Label>
                  <Input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder={t('pr.field_base_url_placeholder')}
                    spellCheck={false}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_base_url_hint')}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label>{t('pr.field_base_url')}</Label>
                  <p className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all">
                    {schema.base_url}
                  </p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t('pr.field_base_url_fixed', { protocol: protocolLabel(protocol, lang) })}
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {/* 已保存的密钥只以提示的形式露一半：可核对、可替换，但读不出明文。 */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('pr.field_key_current')}</span>
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-foreground">{provider.key_hint}</code>
                </div>
                {schema.oauth ? (
                  <OAuthConnect onConnected={setProviderKey} />
                ) : (
                  <>
                    <Label>{t('pr.field_key')}</Label>
                    <Input
                      type="password"
                      value={providerKey}
                      onChange={(event) => setProviderKey(event.target.value)}
                      placeholder={t('pr.field_key_keep')}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_key_edit_hint')}</p>
                  </>
                )}
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>{t('pr.field_label')}</Label>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('pr.field_label_placeholder')} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t('pr.field_enabled')}</Label>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_enabled_hint')}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t('pr.field_enabled')} />
          </div>

          {error ? <ErrorNote message={error} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={update.isPending || schema === null}>
            {update.isPending ? t('pr.saving') : t('action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
