import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, FingerprintIcon, KeyRoundIcon, UploadIcon } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../i18n';
import { useIdentity } from '../identity-context';
import { shortAddress, usd } from '../lib/format';
import { useMe } from '../queries';
import { encodeKeypairJson } from '../seed';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { ErrorNote } from './page';

/**
 * 身份面板：地址、导出的密钥、导入新密钥。
 *
 * 密钥是本机看到的唯一私密物，只有用户主动点「导出密钥」时才写进 DOM——默认不落渲染树。
 * 导出给两种形状：base58 的 64 字节（Norm 自己的备份格式），以及 JSON 数组
 * （Solana 的 id.json 形状，方便拿去和钱包工具互通）。
 */
export function IdentityDialog() {
  const { t } = useI18n();
  const { identity, exportSeed, importIdentity, migratedFromLegacy } = useIdentity();
  const me = useMe(true);
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [seedText, setSeedText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'address' | 'seed' | 'json' | null>(null);

  const copy = async (value: string, kind: 'address' | 'seed' | 'json') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // 无剪贴板权限时保持静默：用户可以手动选中。
    }
  };

  const reset = () => {
    setRevealed(false);
    setSeedText('');
    setImportError(null);
  };

  /** Solana id.json 形状：只在用户点了「复制 JSON 数组」时才计算。 */
  const keypairJson = () => encodeKeypairJson(identity.keypair);

  const submitImport = () => {
    setImportError(null);
    try {
      importIdentity(seedText);
      setSeedText('');
      setOpen(false);
    } catch {
      setImportError(t('identity.import_invalid'));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" size="sm" className="gap-1.5 px-2 font-mono text-xs" aria-label={t('identity.title')} />}
      >
        <FingerprintIcon />
        <span className="hidden sm:inline">{shortAddress(identity.address)}</span>
      </DialogTrigger>

      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('identity.title')}</DialogTitle>
          <DialogDescription>{t('identity.desc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{t('identity.address')}</p>
            <div className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all">{identity.address}</code>
              <Button variant="ghost" size="icon-xs" onClick={() => void copy(identity.address, 'address')} aria-label={t('action.copy')}>
                {copied === 'address' ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
              <div className="flex gap-1">
                <dt>{t('identity.balance')}</dt>
                <dd className="text-foreground tabular-nums">{usd(me.data?.balance_nanos)}</dd>
              </div>
              <div className="flex gap-1">
                <dt>{t('identity.spend')}</dt>
                <dd className="text-foreground tabular-nums">{usd(me.data?.spend_nanos)}</dd>
              </div>
              <div className="flex gap-1">
                <dt>{t('identity.requests')}</dt>
                <dd className="text-foreground tabular-nums">{me.data?.requests ?? '—'}</dd>
              </div>
            </dl>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">{t('identity.keypair_note')}</p>

          {migratedFromLegacy ? (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {t('identity.migrated_note')}
            </p>
          ) : null}

          <Separator />

          <div className="flex flex-col gap-1.5">
            <Label>{t('identity.export_title')}</Label>
            {revealed ? (
              <>
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
                  <code className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all">{exportSeed()}</code>
                  <Button variant="ghost" size="icon-xs" onClick={() => void copy(exportSeed(), 'seed')} aria-label={t('action.copy')}>
                    {copied === 'seed' ? <CheckIcon /> : <CopyIcon />}
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-destructive">{t('identity.export_warn')}</p>
              </>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setRevealed((prev) => !prev)}>
                {revealed ? <EyeOffIcon /> : <EyeIcon />}
                {revealed ? t('action.hide') : t('action.export_seed')}
              </Button>
              {revealed ? (
                <Button variant="ghost" size="sm" onClick={() => void copy(keypairJson(), 'json')}>
                  {copied === 'json' ? <CheckIcon /> : <CopyIcon />}
                  {t('action.copy_json')}
                </Button>
              ) : null}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('identity.export_json_note')}</p>
          </div>

          <Separator />

          <div className="flex flex-col gap-1.5">
            <Label>{t('identity.import_title')}</Label>
            <Input
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
              placeholder={t('identity.import_placeholder')}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('identity.import_note')}</p>
            {importError ? <ErrorNote message={importError} /> : null}
            <Button size="sm" className="self-start" onClick={submitImport} disabled={!seedText.trim()}>
              <UploadIcon />
              {t('action.import_seed')}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
          <KeyRoundIcon className="size-3.5" />
          <span>{t('identity.new_identity')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
