/**
 * FormCard — 表单工具（schema 驱动面板）
 *
 * 设计原则（对齐 step9-forms.md §2.D / §5 隐私边界）：
 *   - 字段由 AI 声明的 schema（FormBlock.fields）驱动渲染：string / number /
 *     boolean / textarea / select / secret / date / time / datetime / month / week
 *   - read="full"（默认）：AI 可见字段值；secret 字段服务端强制掩码
 *   - read="none"：值不写入 DOM / 状态，控件仅展示字段名（值由用户填写后
 *     直接构造对象发服务端，前端不持久化原文）
 *   - 提交走 router_dispatch("cap.ai.chat", { action:"form_submit", formId, values })
 *   - 跳过走 router_dispatch("cap.ai.chat", { action:"form_skip", formId })
 *   - 服务端回执经 form-answered / form-skipped 事件落回 block，本卡据此切状态
 */

import { memo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { CheckCircle, CircleX, ClipboardList, Loader2, Send, XCircle } from 'lucide-react';
import { aiChatDispatch } from '@/services/aiChatDispatch';
import { createLogger } from '@/utils/logger';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '../../Common/Button';
import type { FormBlock, FormFieldSchema } from '@/types';

const log = createLogger('FormCard');

/** 单个字段的提交值（原文只在提交瞬间构造） */
type FieldValues = Record<string, string | number | boolean>;

export interface FormCardProps {
  block: FormBlock;
}

export const FormCard = memo(function FormCard({ block }: FormCardProps) {
  const { t } = useTranslation('chat');

  // read=none：字段值不进入 React state，用非受控控件（defaultValue）+ ref 收集，
  // 提交瞬间构造 values 对象发服务端 → 引用于提交后即弃，无持久化原文。
  // read=full：受控 state（服务端按 read 决定是否回填值，secret 仍掩码）。
  const readNone = block.read === 'none';
  // 私密提交开关：用户一键把填写内容锁在 AI 上下文之外。read=none 时默认勾选；
  // read=full 时用户可手动勾选（服务端强制脱敏，不信任 AI 声明的 read）。
  const [privateSubmit, setPrivateSubmit] = useState<boolean>(readNone);
  const [rawValues, setRawValues] = useState<FieldValues>(() => {
    if (readNone) return {};
    const init: FieldValues = {};
    for (const f of block.fields) {
      if (f.default !== undefined) init[f.name] = f.default;
    }
    return init;
  });
  // read=none 用非受控控件，提交时从 DOM ref 收集
  const fieldRefs = useRef<Record<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const isSubmitted = block.status === 'submitted';
  const isSkipped = block.status === 'skipped';

  const registerRef = useCallback(
    (name: string) =>
      (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => {
        fieldRefs.current[name] = el;
      },
    []
  );

  const setValue = useCallback(
    (name: string, value: string | number | boolean) => {
      if (readNone) return; // 非受控：不进入 state
      setRawValues((prev) => ({ ...prev, [name]: value }));
    },
    [readNone]
  );

  // 收集当前提交值（read=none 从 DOM ref；read=full 从 state）
  const collectValues = useCallback((): FieldValues => {
    if (!readNone) return rawValues;
    const vals: FieldValues = {};
    for (const f of block.fields) {
      if (f.secret) continue; // secret 字段 read=none 时不读 ref（值仍不可见）
      const el = fieldRefs.current[f.name];
      if (!el) continue;
      const raw = el.value;
      if (f.type === 'number') vals[f.name] = raw === '' ? '' : Number(raw);
      else if (f.type === 'boolean') vals[f.name] = (el as HTMLInputElement).checked;
      else vals[f.name] = raw;
    }
    return vals;
  }, [readNone, rawValues, block.fields]);

  const submit = useCallback(async () => {
    if (isSubmitted || isSkipped || submitting) return;
    if (!block.sessionId) {
      useToastStore.getState().error(
        t('form.noSession', '表单未绑定会话，无法提交'),
        ''
      );
      return;
    }
    // 必填校验（前端兜底；服务端 form_core 仍强制）
    const values = collectValues();
    const missing = block.fields
      .filter((f) => f.required)
      .filter((f) => {
        const v = values[f.name];
        return v === undefined || v === null || String(v).trim() === '';
      })
      .map((f) => f.label || f.name);
    if (missing.length > 0) {
      useToastStore.getState().error(
        t('form.missingRequired', '必填项未填写'),
        missing.join('、')
      );
      return;
    }
    setSubmitting(true);
    try {
      await aiChatDispatch({
        action: 'form_submit',
        sessionId: block.sessionId,
        formId: block.id,
        values,
        private: privateSubmit,
      });
      // 成功后无需本地改状态：form-answered 事件会经 eventHandler 更新 block
    } catch (error) {
      log.error(
        '表单提交失败:',
        error instanceof Error ? error : new Error(String(error))
      );
      useToastStore.getState().error(
        t('form.submitFailed', '提交失败'),
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setSubmitting(false);
    }
  }, [block, isSubmitted, isSkipped, submitting, privateSubmit, collectValues, t]);

  // 跳过：用户主动放弃填写。服务端把「已跳过」回执喂给挂起的 form 工具调用，
  // AI 感知后自行决定是否重拉。服务端会广播 form-skipped 事件 → block 置 skipped。
  const skip = useCallback(async () => {
    if (isSubmitted || isSkipped || submitting || skipping) return;
    if (!block.sessionId) return;
    setSkipping(true);
    try {
      await aiChatDispatch({
        action: 'form_skip',
        sessionId: block.sessionId,
        formId: block.id,
      });
    } catch (error) {
      log.error(
        '表单跳过失败:',
        error instanceof Error ? error : new Error(String(error))
      );
      useToastStore.getState().error(
        t('form.submitFailed', '跳过失败'),
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setSkipping(false);
    }
  }, [block, isSubmitted, isSkipped, submitting, skipping, t]);

  // ===== 已提交/已跳过态：展示服务端回执（read=none 时回执不含字段值） =====
  if (isSubmitted || isSkipped) {
    return (
      <div
        role="group"
        className="my-2 rounded-lg border overflow-hidden bg-bg-primary/40 border-border"
      >
        <div
          className={clsx(
            'flex items-center gap-2 px-3 py-2 border-b',
            isSkipped
              ? 'bg-text-tertiary/10 border-text-tertiary/20'
              : block.ok
                ? 'bg-success-faint/40 border-success/20'
                : 'bg-error-faint/40 border-error/20'
          )}
        >
          {isSkipped ? (
            <XCircle className="w-4 h-4 text-text-tertiary shrink-0" aria-hidden="true" />
          ) : block.ok ? (
            <CheckCircle className="w-4 h-4 text-success shrink-0" aria-hidden="true" />
          ) : (
            <CircleX className="w-4 h-4 text-error shrink-0" aria-hidden="true" />
          )}
          <span
            className={clsx(
              'text-sm font-medium',
              isSkipped ? 'text-text-tertiary' : block.ok ? 'text-success' : 'text-error'
            )}
          >
            {isSkipped
              ? t('form.skipped', '已跳过')
              : block.ok
                ? t('form.submitted', '已提交')
                : t('form.submitFailed', '提交失败')}
          </span>
          {block.read !== 'none' && (
            <span className="ml-auto text-[11px] text-text-tertiary">
              {t('form.to', '目标')}: {block.target}
            </span>
          )}
        </div>
        {!isSkipped && block.receipt && (
          <pre className="p-3 text-xs text-text-secondary whitespace-pre-wrap break-words font-mono max-h-64 overflow-auto">
            {block.receipt}
          </pre>
        )}
        {isSkipped && block.receipt && (
          <pre className="p-3 text-xs text-text-tertiary whitespace-pre-wrap break-words font-mono max-h-64 overflow-auto">
            {block.receipt}
          </pre>
        )}
      </div>
    );
  }

  if (block.fields.length === 0) {
    return (
      <div className="my-2 rounded-lg border border-warning/30 bg-warning-faint/30 p-3 text-xs text-text-tertiary">
        {t('form.empty', '空表单块')}
      </div>
    );
  }

  // ===== 未提交态：schema 驱动 + 隐私边界 + 跳过 =====

  return (
    <div
      role="form"
      aria-labelledby={`form-title-${block.id}`}
      className="my-2 rounded-lg border overflow-hidden flex flex-col bg-accent-faint/30 border-accent/30"
    >
      {/* 顶部：标题 + read 模式 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-accent/20 bg-accent-faint/50">
        <ClipboardList className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
        <span id={`form-title-${block.id}`} className="text-sm font-medium text-text-primary">
          {block.title || t('form.label', '表单')}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {readNone && (
            <span className="text-[11px] text-text-tertiary px-1.5 py-0.5 rounded bg-background-elevated/60">
              {t('form.readNone', '隐私模式 · 值不保留')}
            </span>
          )}
          {block.mode === 'collect' ? (
            <span className="text-[11px] text-accent px-1.5 py-0.5 rounded bg-accent-faint/60">
              {t('form.modeCollect', '参数收集')}
            </span>
          ) : (
            !readNone && (
              <span className="text-[11px] text-text-tertiary px-1.5 py-0.5 rounded bg-background-elevated/60">
                {t('form.to', '目标')}: {block.target}
              </span>
            )
          )}
          {block.template?.name && (
            <span className="text-[10px] text-text-tertiary px-1.5 py-0.5 rounded bg-background-elevated/60">
              {t('form.templateFrom', '来自模板')}: {block.template.name}
            </span>
          )}
        </span>
      </div>

      {/* 字段列表 */}
      <div className="p-3 space-y-3">
        {block.fields.map((field) => (
          <FormField
            key={field.name}
            field={field}
            uncontrolled={readNone}
            value={readNone ? undefined : rawValues[field.name]}
            controlRef={registerRef(field.name)}
            disabled={submitting || skipping}
            onChange={(v) => setValue(field.name, v)}
          />
        ))}
      </div>

      {/* 底部：私密开关 + 跳过 + 提交 */}
      <div className="shrink-0 px-3 py-2 border-t border-accent/20 bg-background-elevated/50 flex items-center gap-2">
        <label
          className="flex items-center gap-1.5 text-[11px] text-text-tertiary cursor-pointer select-none mr-auto"
          title={t(
            'form.privateHint',
            '勾选后，你填写的内容与提交结果都不会进入 AI 的上下文'
          )}
        >
          <input
            type="checkbox"
            checked={privateSubmit}
            onChange={(e) => setPrivateSubmit(e.target.checked)}
            disabled={submitting || skipping}
            className="accent-accent w-3.5 h-3.5"
          />
          {t('form.privateSubmit', '私密提交 · AI 不可见')}
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void skip()}
          disabled={submitting || skipping || isSkipped}
          className="ml-4"
        >
          {skipping ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              {t('form.submitting')}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
              {t('form.skip', '跳过')}
            </span>
          )}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void submit()}
          disabled={submitting || skipping}
        >
          {submitting ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              {t('form.submitting')}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Send className="w-3.5 h-3.5" aria-hidden="true" />
              {t('form.submit', '提交')}
            </span>
          )}
        </Button>
      </div>
    </div>
  );
});

// ================================================================
// 单个 schema 字段控件（按 type 分发）
// ================================================================

interface FormFieldProps {
  field: FormFieldSchema;
  /** 非受控模式下 value/onChange 忽略，控件直接读写 DOM（值不进入 React state） */
  uncontrolled: boolean;
  value?: string | number | boolean;
  controlRef: (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => void;
  disabled: boolean;
  onChange: (v: string | number | boolean) => void;
}

function FormField({ field, uncontrolled, value, controlRef, disabled, onChange }: FormFieldProps) {
  const { t } = useTranslation('chat');
  const type = field.type ?? 'string';
  const id = `form-field-${field.name}`;
  const requiredMark = field.required ? ' *' : '';
  const isSecret = !!field.secret;

  // 非受控模式：read=none 时值不进入 React state，控件用 defaultValue + ref 读写。
  // 受控模式：read=full 时 value/onChange 为真，值经 state 流转（回执由服务端决定是否回填）。
  const inputCls = clsx(
    'w-full px-3 py-1.5 rounded-md text-sm bg-bg-secondary border border-border',
    'focus:border-accent focus:ring-1 focus:ring-accent outline-none',
    'placeholder:text-text-tertiary disabled:opacity-50 disabled:cursor-not-allowed'
  );

  const renderControl = () => {
    if (isSecret) {
      // secret 字段密码框：无论 read 模式，值都不持久化（read=full 也只在提交瞬间构造）
      return (
        <input
          id={id}
          type="password"
          ref={controlRef}
          defaultValue={uncontrolled && typeof value !== 'boolean' ? (value as string) ?? '' : undefined}
          value={!uncontrolled && typeof value === 'string' ? value : undefined}
          onChange={(e) => !uncontrolled && onChange(e.target.value)}
          placeholder={field.placeholder || t('form.secretPlaceholder', '输入保密值……')}
          disabled={disabled}
          autoComplete="off"
          className={inputCls}
          data-secret
        />
      );
    }

    // 时间类控件：date / time / datetime-local / month / week 都是原生 input，
    // 值一律作为 string 提交（服务端 target 能力按需解析）。min/max/step 透传。
    const temporalTypes = ['date', 'time', 'datetime', 'month', 'week'] as const;
    const nativeInputType: Record<(typeof temporalTypes)[number], string> = {
      date: 'date',
      time: 'time',
      datetime: 'datetime-local',
      month: 'month',
      week: 'week',
    };

    switch (type) {
      case 'number':
        return (
          <input
            id={id}
            type="number"
            ref={controlRef}
            defaultValue={uncontrolled && typeof value !== 'boolean' ? (value as string) ?? '' : undefined}
            value={!uncontrolled && typeof value === 'string' ? value : undefined}
            onChange={(e) =>
              !uncontrolled &&
              onChange(e.target.value === '' ? '' : Number(e.target.value))
            }
            placeholder={field.placeholder}
            disabled={disabled}
            className={inputCls}
          />
        );
      case 'boolean':
        return (
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              id={id}
              type="checkbox"
              ref={controlRef}
              defaultChecked={uncontrolled ? Boolean(value) : undefined}
              checked={!uncontrolled ? Boolean(value) : undefined}
              onChange={(e) => !uncontrolled && onChange(e.target.checked)}
              disabled={disabled}
              className="accent-accent w-4 h-4"
            />
            {t('form.yesNo', '是')}
          </label>
        );
      case 'textarea':
        return (
          <textarea
            id={id}
            ref={controlRef}
            defaultValue={uncontrolled && typeof value !== 'boolean' ? (value as string) ?? '' : undefined}
            value={!uncontrolled && typeof value === 'string' ? value : undefined}
            onChange={(e) => !uncontrolled && onChange(e.target.value)}
            placeholder={field.placeholder}
            disabled={disabled}
            rows={3}
            className={clsx(inputCls, 'resize-y')}
          />
        );
      case 'select':
        return (
          <select
            id={id}
            ref={controlRef}
            defaultValue={uncontrolled && typeof value !== 'boolean' ? (value as string) ?? '' : undefined}
            value={!uncontrolled && typeof value === 'string' ? value : undefined}
            onChange={(e) => !uncontrolled && onChange(e.target.value)}
            disabled={disabled}
            className={inputCls}
          >
            <option value="">{t('form.selectPlaceholder', '请选择……')}</option>
            {(field.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        );
      case 'date':
      case 'time':
      case 'datetime':
      case 'month':
      case 'week': {
        const inputType = nativeInputType[type];
        return (
          <input
            id={id}
            type={inputType}
            ref={controlRef}
            defaultValue={uncontrolled && typeof value !== 'boolean' ? (value as string) ?? '' : undefined}
            value={!uncontrolled && typeof value === 'string' ? value : undefined}
            onChange={(e) => !uncontrolled && onChange(e.target.value)}
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            className={inputCls}
          />
        );
      }
      case 'string':
      default:
        return (
          <input
            id={id}
            type="text"
            ref={controlRef}
            defaultValue={uncontrolled && typeof value !== 'boolean' ? (value as string) ?? '' : undefined}
            value={!uncontrolled && typeof value === 'string' ? value : undefined}
            onChange={(e) => !uncontrolled && onChange(e.target.value)}
            placeholder={field.placeholder}
            disabled={disabled}
            className={inputCls}
          />
        );
    }
  };

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text-secondary mb-1">
        {field.label || field.name}
        {requiredMark}
        {isSecret && (
          <span className="ml-1.5 text-[10px] text-text-tertiary">
            {t('form.secretTag', '保密')}
          </span>
        )}
        {!isSecret && field.hidden && (
          <span className="ml-1.5 text-[10px] text-warning/80" title={t('form.hiddenHint', '值会参与处理，但不会进入 AI 上下文')}>
            {t('form.hiddenTag', 'AI 不可见')}
          </span>
        )}
      </label>
      {renderControl()}
    </div>
  );
}

export default FormCard;