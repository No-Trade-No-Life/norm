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
import { useCreateProvider, useProviders, useRevokeProvider, useSetEnabled, useSetVisibility } from '../queries';
import { PROTOCOLS, VISIBILITIES, type Provider } from '../types';
import { protocolLabel, trustLabel, visibilityLabel } from '../lib/labels';

export function ProvidersPage() {
  const { t, lang } = useI18n();
  const providers = useProviders(true);
  const setVisibility = useSetVisibility();
  const setEnabled = useSetEnabled();
  const revoke = useRevokeProvider();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const items = providers.data?.items ?? [];

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
                <TableHead className="hidden xl:table-cell">{t('pr.col_visibility')}</TableHead>
                <TableHead>{t('pr.col_trust')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('pr.col_hint')}</TableHead>
                <TableHead>{t('pr.col_enabled')}</TableHead>
                <TableHead>{t('pr.col_public')}</TableHead>
                <TableHead className="text-right">{t('pr.col_actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <ProviderRow
                  key={item.id}
                  item={item}
                  confirming={confirmId === item.id}
                  onConfirm={(value) => setConfirmId(value ? item.id : null)}
                  onToggleEnabled={(value) => setEnabled.mutate({ id: item.id, enabled: value })}
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

      {setEnabled.isError ? <ErrorNote title={t('common.error')} message={(setEnabled.error as Error).message} /> : null}
      {setVisibility.isError ? <ErrorNote title={t('common.error')} message={(setVisibility.error as Error).message} /> : null}
      {revoke.isError ? <ErrorNote title={t('common.error')} message={(revoke.error as Error).message} /> : null}

      <NewProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => {
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

function ProviderRow({
  item,
  lang,
  confirming,
  onConfirm,
  onToggleEnabled,
  onTogglePublic,
  onRevoke,
}: {
  item: Provider;
  lang: 'zh' | 'en';
  confirming: boolean;
  onConfirm: (value: boolean) => void;
  onToggleEnabled: (value: boolean) => void;
  onTogglePublic: (value: boolean) => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const off = item.enabled === 0;

  return (
    <TableRow className={off ? 'opacity-60' : undefined}>
      <TableCell className="font-medium">{item.label}</TableCell>
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
      <TableCell className="hidden xl:table-cell">
        <span className="text-xs">{visibilityLabel(item.visibility, lang)}</span>
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
          <Switch checked={item.enabled === 1} onCheckedChange={onToggleEnabled} aria-label={t('pr.col_enabled')} />
          <span className="hidden text-[11px] whitespace-nowrap text-muted-foreground xl:inline">
            {item.enabled === 1 ? t('pr.enabled_on') : t('pr.enabled_off')}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch checked={item.public_listed === 1} onCheckedChange={onTogglePublic} aria-label={t('pr.col_public')} />
          <span className="hidden text-[11px] whitespace-nowrap text-muted-foreground xl:inline">
            {item.public_listed === 1 ? t('pr.public_on') : t('pr.public_off')}
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

  const [label, setLabel] = useState('');
  const [providerKey, setProviderKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState<string>('openai-chat');
  const [visibility, setVisibility] = useState<string>('private');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel('');
    setProviderKey('');
    setEnabled(true);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!label.trim() || !providerKey.trim() || !baseUrl.trim()) {
      setError(t('pr.missing'));
      return;
    }
    try {
      // 明文密钥这一次经过请求体，服务端立刻用 Worker secret 封装，之后只剩提示。
      await create.mutateAsync({
        label: label.trim(),
        base_url: baseUrl.trim(),
        provider_key: providerKey.trim(),
        protocol: protocol,
        visibility: visibility,
        enabled,
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
            <Label>{t('pr.field_label')}</Label>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('pr.field_label_placeholder')} />
          </div>

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

          <div className="flex flex-col gap-1.5">
            <Label>{t('pr.field_protocol')}</Label>
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
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_protocol_hint')}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('pr.field_visibility')}</Label>
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
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_visibility_hint')}</p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t('pr.field_enabled')}</Label>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_enabled_hint')}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t('pr.field_enabled')} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('pr.field_key')}</Label>
            <Input type="password" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} autoComplete="off" spellCheck={false} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('pr.field_key_hint')}</p>
          </div>

          {error ? <ErrorNote message={error} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending ? t('pr.creating') : t('action.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
