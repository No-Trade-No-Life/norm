import { CheckIcon, CopyIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { when } from '../lib/format';
import {
  useConsumers,
  useCreateConsumer,
  useProviders,
  useRenameConsumer,
  useRevokeConsumer,
  useRotateConsumer,
} from '../queries';
import type { Consumer, Provider } from '../types';

/**
 * 下游消费者：给程序用的 `sk-norm-…`。
 *
 * 与「上游提供者」页的区别是「谁在说话」：那一页管资源（钱付给谁、上游在哪），
 * 这一页管消费（谁的代码拿着 Token 来敲门）。
 *
 * 一条 Token 在建的时候就绑死一条上游提供者，所以程序侧一次调用只要
 * `Authorization: Bearer sk-norm-…`——再没有第二个 Norm 专有的头。
 */
export function ConsumersPage() {
  const { t } = useI18n();
  const consumers = useConsumers(true);
  const providers = useProviders(true);
  const revoke = useRevokeConsumer();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Consumer | null>(null);

  const items = consumers.data?.items ?? [];
  const upstreams = providers.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('co.title')}
        description={t('co.desc')}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t('co.new')}
          </Button>
        }
      />

      <Section bodyClassName="p-0">
        {consumers.isPending ? (
          <SkeletonRows rows={3} cols={4} />
        ) : consumers.isError ? (
          <div className="p-3">
            <ErrorNote title={t('common.error')} message={(consumers.error as Error).message} />
          </div>
        ) : items.length === 0 ? (
          <Empty className="border-0">{t('co.empty')}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('co.col_name')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('co.col_provider')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('co.col_hint')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('co.col_created')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('co.col_last_used')}</TableHead>
                <TableHead className="text-right">{t('co.col_actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <ConsumerRow
                  key={item.id}
                  item={item}
                  onRename={() => setRenaming(item)}
                  onRevealed={setRevealed}
                  onRevoke={() => revoke.mutate(item.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {revoke.isError ? <ErrorNote title={t('common.error')} message={(revoke.error as Error).message} /> : null}

      <NewConsumerDialog
        open={createOpen}
        upstreams={upstreams}
        onOpenChange={setCreateOpen}
        onCreated={setRevealed}
      />
      <RenameDialog consumer={renaming} onClose={() => setRenaming(null)} />
      {revealed ? <KeyDialog value={revealed} onClose={() => setRevealed(null)} /> : null}
    </div>
  );
}

function ConsumerRow({
  item,
  onRename,
  onRevealed,
  onRevoke,
}: {
  item: Consumer;
  onRename: () => void;
  onRevealed: (key: string) => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const rotate = useRotateConsumer();
  const [confirming, setConfirming] = useState<'rotate' | 'revoke' | null>(null);

  const runRotate = async () => {
    const result = await rotate.mutateAsync(item.id);
    onRevealed(result.key);
    setConfirming(null);
  };

  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{item.name}</span>
        {/* 窄屏没有独立的密钥列，提示要贴在名字下面，事实不能被藏起来。 */}
        <code className="mt-0.5 block font-mono text-[11px] text-muted-foreground sm:hidden">{item.key_hint}</code>
        <span className="mt-0.5 block text-[11px] text-muted-foreground md:hidden">
          {item.provider_label ?? `${t('co.or_revoked')} ${item.provider_id}`}
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {item.provider_label ? (
          <div className="flex flex-col">
            <span className="text-xs">{item.provider_label}</span>
            <code className="text-[11px] break-all text-muted-foreground">{item.provider_base_url}</code>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t('co.or_revoked')} <code className="text-[11px]">{item.provider_id}</code>
          </span>
        )}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <code className="text-xs text-muted-foreground">{item.key_hint}</code>
      </TableCell>
      <TableCell className="hidden text-xs text-muted-foreground tabular-nums lg:table-cell">{when(item.created_at)}</TableCell>
      <TableCell className="hidden md:table-cell">
        {item.last_used_at ? (
          <span className="text-xs text-muted-foreground tabular-nums">{when(item.last_used_at)}</span>
        ) : (
          <Badge variant="outline" className="font-normal">
            {t('co.never_used')}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={onRename}>
            {t('co.rename')}
          </Button>
          <Button
            variant={confirming === 'rotate' ? 'destructive' : 'ghost'}
            size="sm"
            className="whitespace-nowrap"
            disabled={rotate.isPending}
            onClick={() => (confirming === 'rotate' ? void runRotate() : setConfirming('rotate'))}
          >
            {confirming === 'rotate' ? t('co.rotate_confirm') : t('co.rotate')}
          </Button>
          <Button
            variant={confirming === 'revoke' ? 'destructive' : 'ghost'}
            size="sm"
            className="whitespace-nowrap"
            onClick={() => (confirming === 'revoke' ? onRevoke() : setConfirming('revoke'))}
          >
            {confirming === 'revoke' ? t('co.revoke_confirm') : t('co.revoke')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function NewConsumerDialog({
  open,
  upstreams,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  upstreams: Provider[];
  onOpenChange: (value: boolean) => void;
  onCreated: (key: string) => void;
}) {
  const { t } = useI18n();
  const create = useCreateConsumer();
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 默认选中第一条：绝大多数人只有一条上游，让他少点一次。
  const selected = providerId || upstreams[0]?.id || '';

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t('co.missing'));
      return;
    }
    if (!selected) {
      setError(t('co.provider_missing'));
      return;
    }
    try {
      const result = await create.mutateAsync({ name: name.trim(), provider_id: selected });
      setName('');
      onOpenChange(false);
      onCreated(result.key);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('co.new_title')}</DialogTitle>
          <DialogDescription>{t('co.new_desc')}</DialogDescription>
        </DialogHeader>

        {upstreams.length === 0 ? (
          <Empty className="border-0">{t('co.no_provider')}</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{t('co.field_name')}</Label>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('co.field_name_placeholder')} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>{t('co.field_provider')}</Label>
              {/* 绑定只在建钥时定一次：它决定了这次调用的钱付给哪条上游、打到哪台主机。 */}
              <Select
                value={selected}
                onValueChange={(value) => setProviderId(String(value))}
                items={upstreams.map((item) => ({ value: item.id, label: item.label }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('co.field_provider_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {upstreams.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="font-mono text-[11px] leading-relaxed break-all text-muted-foreground">
                {upstreams.find((item) => item.id === selected)?.base_url ?? ''}
              </p>
            </div>
          </div>
        )}

        {error ? <ErrorNote message={error} /> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || upstreams.length === 0}>
            {create.isPending ? t('co.creating') : t('co.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ consumer, onClose }: { consumer: Consumer | null; onClose: () => void }) {
  const { t } = useI18n();
  const rename = useRenameConsumer();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!consumer) return;
    setError(null);
    if (!name.trim()) {
      setError(t('co.missing'));
      return;
    }
    try {
      await rename.mutateAsync({ id: consumer.id, name: name.trim() });
      setName('');
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <Dialog
      open={consumer !== null}
      onOpenChange={(next) => {
        if (!next) {
          setName('');
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('co.rename_title')}</DialogTitle>
          <DialogDescription>{consumer?.key_hint}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label>{t('co.field_name')}</Label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={consumer?.name}
            autoFocus
          />
        </div>

        {error ? <ErrorNote message={error} /> : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={rename.isPending}>
            {t('action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一次性明文：只在创建与轮换后弹一次，关掉即无法再取。 */
function KeyDialog({ value, onClose }: { value: string; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 没有剪贴板权限时用户可以手动选中，不做额外提示。
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('co.reveal_title')}</DialogTitle>
          <DialogDescription>{t('co.reveal_body')}</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <code className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">{value}</code>
          <Button variant="ghost" size="icon-xs" onClick={() => void copy()} aria-label={t('action.copy')}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>

        <div className="rounded-lg border border-border px-3 py-2">
          <p className="text-[11px] font-semibold text-foreground">{t('co.entries_title')}</p>
          <p className="mt-1 font-mono text-[10px] leading-relaxed break-all text-muted-foreground">
            /v1/chat/completions · /v1/responses · /v1/messages · /v1/models/{'{model}'}:generateContent
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{t('co.entries_body')}</p>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t('co.usage_hint')}</p>

        <DialogFooter>
          <Button onClick={onClose}>{t('co.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
