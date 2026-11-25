import { CheckIcon, CopyIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Empty, ErrorNote, PageHeader, Section, SkeletonRows } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useI18n } from '../i18n';
import { when } from '../lib/format';
import {
  useConsumers,
  useCreateConsumer,
  useRenameConsumer,
  useRevokeConsumer,
  useRotateConsumer,
} from '../queries';
import type { Consumer } from '../types';

/**
 * 下游消费者：给程序用的 `sk-norm-…`。
 *
 * 与「上游提供商」页的区别是「谁在说话」：那一页管资源（钱付给谁、上游在哪），
 * 这一页管消费（谁的代码拿着 Token 来敲门）。
 *
 * 所以这里只有名字：Token 不绑定上游提供商。走哪条是每次转发自己的决定——
 * 账户里只有一条启用的上游提供商时就那一条，有多条时才在请求里用 `X-Norm-Provider` 指名。
 * 于是「添一条上游提供商、建一条 Token、把它当普通 api key 用」就是全部，
 * 建密钥不必先想清楚它将来会打哪个上游。
 *
 * 建一条 Token 只有「起个名」这一个参数，所以不配对话框：按钮本身就是那一次创建，
 * 名字先给一个默认值，事后再改。唯一必须停一下的是密钥本身——明文只出现一次。
 */
export function ConsumersPage() {
  const { t } = useI18n();
  const consumers = useConsumers(true);
  const create = useCreateConsumer();
  const revoke = useRevokeConsumer();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Consumer | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const items = consumers.data?.items ?? [];

  // 按钮即创建：名字只是备注，默认值取一个没被占用的序号，用户随后改名即可。
  const createNow = async () => {
    setCreateError(null);
    try {
      const result = await create.mutateAsync({ name: nextName(t('co.default_name'), items) });
      setRevealed(result.key);
    } catch (caught) {
      setCreateError((caught as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('co.title')}
        description={t('co.desc')}
        actions={
          <Button onClick={() => void createNow()} disabled={create.isPending}>
            <PlusIcon />
            {create.isPending ? t('co.creating') : t('co.new')}
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

      {createError ? <ErrorNote title={t('common.error')} message={createError} /> : null}
      {revoke.isError ? <ErrorNote title={t('common.error')} message={(revoke.error as Error).message} /> : null}

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

/** 默认备注名：`未命名消费者 1`，取第一个没被占用的序号。 */
function nextName(base: string, existing: Consumer[]): string {
  const taken = new Set(existing.map((item) => item.name));
  for (let index = 1; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
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
