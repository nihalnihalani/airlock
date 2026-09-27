import type * as React from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The prompt area at the bottom of a conversation, drawn like OpenBot's compact composer
 * (`rounded-2xl border bg-card px-3 py-3`, centred in the transcript's `max-w-2xl` column).
 */
export function ComposerFrame({
  children,
  above,
  footnote,
  className,
  as = "div",
  onSubmit,
}: {
  children: ReactNode;
  above?: ReactNode;
  footnote?: ReactNode;
  className?: string;
  as?: "div" | "form";
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  const frame = cn(
    "flex min-h-14 flex-col gap-2.5 rounded-2xl border border-border bg-card px-3 py-3 shadow-[0_1px_2px_0_rgb(0_0_0/0.03)] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
    className,
  );
  return (
    <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pb-4">
      {above}
      {as === "form" ? (
        <form className={frame} onSubmit={onSubmit}>
          {children}
        </form>
      ) : (
        <div className={frame}>{children}</div>
      )}
      {footnote ? <p className="mt-2 px-2 text-center text-[11px] text-pretty text-muted-foreground">{footnote}</p> : null}
    </div>
  );
}
