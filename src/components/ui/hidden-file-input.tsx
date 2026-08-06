import type { ChangeEvent, Ref } from "react";

// A visually hidden file picker input: the owning UI opens it via the ref.
// The change handler must reset `event.target.value` itself when picking the
// same file twice in a row should fire again.
export function HiddenFileInput({
  inputRef,
  accept,
  multiple = false,
  onChange,
}: {
  inputRef: Ref<HTMLInputElement>;
  accept: string;
  multiple?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      multiple={multiple}
      hidden
      onChange={onChange}
    />
  );
}
