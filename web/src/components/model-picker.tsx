import { useMemo, useState, type ReactNode } from 'react';
import { ListIcon, PencilIcon } from 'lucide-react';

import { useI18n } from '../i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from './ui/select';

/**
 * 模型选择器：能从清单里选就从清单里选，选不到就手填。
 *
 * 四个工具页的清单来源各不相同（聊天问 `/v1/models`、图像与搜索读模型总表、音频按模态筛），
 * 但「先给清单、随时能切回手填」这件事只有一份实现：清单为空时直接是输入框，
 * 不是让人对着一个空下拉发呆。
 */
export function ModelPicker({
  value,
  onChange,
  options,
  placeholder,
  status,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
  status: ReactNode;
  /** 这一栏叫什么：模型、音色……默认是「模型」。 */
  label?: string;
}) {
  const { t } = useI18n();
  const [manual, setManual] = useState(false);
  const items = useMemo(() => {
    const list = options.map((option) => ({ value: option, label: option }));
    if (value && !options.includes(value)) list.push({ value, label: value });
    return list;
  }, [options, value]);
  const pickable = !manual && options.length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{label ?? t('tool.model')}</Label>
        {options.length > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="-my-1 size-6"
            aria-label={pickable ? t('tool.model_manual') : t('tool.model_pick')}
            onClick={() => setManual((current) => !current)}
          >
            {pickable ? <PencilIcon className="size-3.5" /> : <ListIcon className="size-3.5" />}
          </Button>
        ) : null}
      </div>
      {pickable ? (
        <Select value={value} onValueChange={(next) => onChange(String(next))} items={items}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                <span className="font-mono text-xs">{option}</span>
              </SelectItem>
            ))}
            {value && !options.includes(value) ? (
              <SelectItem value={value}>
                <span className="font-mono text-xs">{value}</span>
              </SelectItem>
            ) : null}
            <SelectSeparator />
            <SelectItem value="__manual__" onClick={() => setManual(true)}>
              {t('tool.model_manual')}
            </SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="font-mono text-xs"
        />
      )}
      <p className="text-[11px] text-muted-foreground">{status}</p>
    </div>
  );
}
