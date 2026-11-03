import { useRef, useState } from "react";
import { CalendarDays } from "lucide-react";

const isDate = (text: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) &&
  !Number.isNaN(Date.parse(`${text}T00:00:00.000Z`)) &&
  new Date(`${text}T00:00:00.000Z`).toISOString().startsWith(text);

interface DateFieldProps {
  label: string;
  /** The calendar button's name; it must not contain `label`, or lookups by label match both. */
  pickerLabel: string;
  /** YYYY-MM-DD, or empty for no bound. */
  value: string;
  min?: string;
  onChange: (value: string) => void;
}

/**
 * A UTC date shown and typed as YYYY-MM-DD, like every other date in FlowLens,
 * whatever the browser's locale. The calendar button still opens the native picker.
 */
export function DateField({
  label,
  pickerLabel,
  value,
  min,
  onChange,
}: DateFieldProps) {
  // Text that is not a date yet stays in the field without changing the filter.
  const [draft, setDraft] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const shown = draft ?? value;
  return (
    <span className="date-field">
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        aria-invalid={draft !== null}
        placeholder="YYYY-MM-DD"
        maxLength={10}
        value={shown}
        onChange={(event) => {
          const next = event.target.value.trim();
          if (next === "" || isDate(next)) {
            setDraft(null);
            onChange(next);
          } else setDraft(next);
        }}
      />
      <button
        type="button"
        aria-label={pickerLabel}
        onClick={() => picker.current?.showPicker?.()}
      >
        <CalendarDays size={13} />
      </button>
      <input
        ref={picker}
        className="date-picker"
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        min={min}
        onChange={(event) => {
          setDraft(null);
          onChange(event.target.value);
        }}
      />
    </span>
  );
}
