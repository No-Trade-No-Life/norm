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
import { useCreateCredential, useCredentials, useRevokeCredential, useSetVisibility } from '../queries';
import { PROVIDERS, PROTOCOLS, VISIBILITIES, type Credential } from '../types';
import { protocolLabel, trustLabel, visibilityLabel } from '../lib/labels';

export function CredentialsPage() {
  const { t, lang } = useI18n();
  const credentials = useCredentials(true);
  const setVisibility = useSetVisibility();
  const revoke = useRevokeCredential();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const items = credentials.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('cr.title')}
        description={t('cr.desc')}
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <PlusIcon />
            {t('action.new_credential')}
          </Button>
        }
      />

      <Section bodyClassName="p-0">
        {credentials.isPending ? (
          <SkeletonRows rows={4} cols={5} />
        ) : credentials.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(credentials.error as Error).message} />
          </div>
        ) : items.length === 0 ? (
          <Empty className="border-0">{t('cr.empty')}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('cr.col_label')}</TableHead>
                <TableHead className="hidden xl:table-cell">{t('cr.col_provider')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('cr.col_base_url')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('cr.col_protocol')}</TableHead>
                <TableHead className="hidden xl:table-cell">{t('cr.col_visibility')}</TableHead>
                <TableHead>{t('cr.col_trust')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('cr.col_hint')}</TableHead>
                <TableHead>{t('cr.col_public')}</TableHead>
                <TableHead className="text-right">{t('cr.col_actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <CredentialRow
                  key={item.id}
                  item={item}
                  confirming={confirmId === item.id}
                  onConfirm={(value) => setConfirmId(value ? item.id : null)}
                  onTogglePublic={(value) => setVisibility.mutate({ id: item.id, publicListed: value })}
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

      {setVisibility.isError ? <ErrorNote title={t('common.error')} message={(setVisibility.error as Error).message} /> : null}
      {revoke.isError ? <ErrorNote title={t('common.error')} message={(revoke.error as Error).message} /> : null}

      <NewCredentialDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => {
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

function CredentialRow({
  item,
  lang,
  confirming,
  onConfirm,
  onTogglePublic,
  onRevoke,
}: {
  item: Credential;
  lang: 'zh' | 'en';
  confirming: boolean;
  onConfirm: (value: boolean) => void;
  onTogglePublic: (value: boolean) => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();

  return (
    <TableRow>
      <TableCell className="font-medium">{item.label}</TableCell>
      <TableCell className="hidden xl:table-cell">
        <Badge variant="outline">{item.provider}</Badge>
      </TableCell>
      <TableCell className="hidden max-w-64 lg:table-cell">
        <span className="block truncate font-mono text-xs text-muted-foreground" title={item.base_url}>
          {item.base_url}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Badge variant="outline" className="font-normal">
          {protocolLabel(item.upstream_protocol, lang)}
        </Badge>
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        <span className="text-xs">{visibilityLabel(item.upstream_visibility, lang)}</span>
      </TableCell>
      <TableCell>
        {/* 落点只看主机名是否在信任清单里：清单是配置，不是判词。 */}
        <Badge variant={item.trusted ? 'secondary' : 'outline'}>{trustLabel(item.trusted, lang)}</Badge>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <code className="text-xs">{item.key_hint}</code>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch checked={item.public_listed === 1} onCheckedChange={onTogglePublic} aria-label={t('cr.col_public')} />
          <span className="hidden text-[11px] whitespace-nowrap text-muted-foreground xl:inline">
            {item.public_listed === 1 ? t('cr.public_on') : t('cr.public_off')}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant={confirming ? 'destructive' : 'ghost'}
          size="sm"
          className="whitespace-nowrap"
          onClick={() => (confirming ? onRevoke() : onConfirm(true))}
        >
          {confirming ? t('action.revoke_confirm') : t('action.revoke')}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function NewCredentialDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onCreated: () => void;
}) {
  const { t, lang } = useI18n();
  const create = useCreateCredential();

  const [label, setLabel] = useState('');
  const [upstreamKey, setUpstreamKey] = useState('');
  const [provider, setProvider] = useState<string>('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [protocol, setProtocol] = useState<string>('openai-chat');
  const [visibility, setVisibility] = useState<string>('private');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel('');
    setUpstreamKey('');
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!label.trim() || !upstreamKey.trim() || !baseUrl.trim()) {
      setError(t('cr.missing'));
      return;
    }
    try {
      // 明文密钥这一次经过请求体，服务端立刻用 Worker secret 封装，之后只剩提示。
      await create.mutateAsync({
        label: label.trim(),
        provider,
        base_url: baseUrl.trim(),
        upstream_key: upstreamKey.trim(),
        upstream_protocol: protocol,
        upstream_visibility: visibility,
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
          <DialogTitle>{t('cr.new_title')}</DialogTitle>
          <DialogDescription>{t('cr.new_desc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('cr.field_label')}</Label>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('cr.field_label_placeholder')} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t('cr.field_provider')}</Label>
              <Select value={provider} onValueChange={(value) => setProvider(String(value))} items={PROVIDERS.map((p) => ({ value: p, label: p }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('cr.field_protocol')}</Label>
              <Select
                value={protocol}
                onValueChange={(value) => setProtocol(String(value))}
                items={PROTOCOLS.map((p) => ({ value: p, label: protocolLabel(p, lang) }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROTOCOLS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {protocolLabel(p, lang)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('cr.field_base_url')}</Label>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('cr.field_protocol_hint')}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('cr.field_visibility')}</Label>
            <Select
              value={visibility}
              onValueChange={(value) => setVisibility(String(value))}
              items={VISIBILITIES.map((v) => ({ value: v, label: visibilityLabel(v, lang) }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITIES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {visibilityLabel(v, lang)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('cr.field_visibility_hint')}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('cr.field_key')}</Label>
            <Input type="password" value={upstreamKey} onChange={(event) => setUpstreamKey(event.target.value)} autoComplete="off" spellCheck={false} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('cr.field_key_hint')}</p>
          </div>

          {error ? <ErrorNote message={error} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending ? t('cr.creating') : t('action.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
