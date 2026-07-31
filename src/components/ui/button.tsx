import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { useEffect, useRef } from "react"

import { cn } from "@/lib/utils"

// Button — один вид и одно ощущение для всех действий в приложении. Цвета
// меняются за 125ms, нажатие — scale 0.97 на пружине (0.94 при force press
// на трекпаде), solid чуть светлеет в нажатии. will-change-scale постоянный,
// не по :active — слой должен существовать до нажатия, иначе первый кадр
// пере-растеризуется и иконка дёргается. Primary — синий градиент с тенями
// и обводкой-кольцом CTA; hover — brightness 105%, но не во время
// нажатия, чтобы press-фильтр не дрался с яркостью. Loading не превращает
// кнопку в серую: цвета варианта сохраняются, меняется только курсор;
// серое состояние одно — disabled.
const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap btn-transition outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-97 will-change-scale data-[force-press=true]:scale-94 disabled:cursor-not-allowed data-[disabled]:border-transparent data-[disabled]:bg-none data-[disabled]:bg-hover-surface data-[disabled]:text-muted-content data-[disabled]:shadow-none data-[disabled]:text-shadow-none data-[loading]:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-0 bg-primary-gradient text-primary-foreground shadow-primary text-shadow-primary hover:not-active:brightness-105 active:press-solid",
        outline:
          "border-strong bg-raised shadow-card hover:bg-muted-surface active:bg-hover-surface aria-expanded:bg-muted-surface",
        secondary:
          "bg-muted-surface text-strong hover:bg-hover-surface active:bg-active-surface aria-expanded:bg-hover-surface",
        ghost:
          "text-default hover:bg-hover-surface hover:text-strong active:bg-active-surface aria-expanded:bg-hover-surface aria-expanded:text-strong aria-pressed:bg-hover-surface aria-pressed:text-strong",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/15 active:bg-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-7 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-2.5",
        default: "h-9 gap-1.5 px-3",
        lg: "h-10 gap-1.5 px-3",
        icon: "size-9",
        "icon-xs": "size-6.5 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
      shape: {
        square: "",
        round: "rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "sm",
      shape: "square",
    },
  }
)

// Спиннер: дуга пересчитывает длину и темп каждый цикл — читается как
// живой процесс, а не метроном.
function ButtonSpinner({ className }: { className?: string }) {
  return (
    <span className={cn("inline-block size-3.5", className)} role="status">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className="block size-full overflow-visible"
      >
        <circle
          cx="8"
          cy="8"
          r="7"
          stroke="color-mix(in srgb, currentColor 35%, transparent)"
          strokeWidth="2.2857143"
        />
        <g className="spin-linear">
          <g className="spin-ease">
            <circle
              className="spin-arc"
              cx="8"
              cy="8"
              r="7"
              strokeLinecap="round"
              stroke="currentColor"
              strokeWidth="2.2857143"
            />
          </g>
        </g>
      </svg>
    </span>
  )
}

function Button({
  className,
  variant,
  size,
  shape,
  loading = false,
  disabled,
  children,
  ref,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  // Force press (Safari / трекпад с Force Touch): сильное нажатие дожимает
  // scale до 0.94.
  const forceRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = forceRef.current
    if (!el) return
    const begin = (event: Event) => event.preventDefault()
    const down = () => {
      el.dataset.forcePress = "true"
    }
    const up = () => {
      el.dataset.forcePress = "false"
    }
    el.addEventListener("webkitmouseforcewillbegin", begin)
    el.addEventListener("webkitmouseforcedown", down)
    el.addEventListener("webkitmouseforceup", up)
    el.addEventListener("mouseup", up)
    el.addEventListener("mouseleave", up)
    return () => {
      el.removeEventListener("webkitmouseforcewillbegin", begin)
      el.removeEventListener("webkitmouseforcedown", down)
      el.removeEventListener("webkitmouseforceup", up)
      el.removeEventListener("mouseup", up)
      el.removeEventListener("mouseleave", up)
    }
  }, [])

  return (
    <ButtonPrimitive
      data-slot="button"
      ref={(node) => {
        forceRef.current = node
        const button = node as HTMLButtonElement | null
        if (typeof ref === "function") ref(button)
        else if (ref) ref.current = button
      }}
      data-disabled={disabled || undefined}
      data-loading={loading || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, shape, className }))}
      {...props}
    >
      {loading ? (
        <>
          <ButtonSpinner className="absolute left-2.5" />
          <span className="btn-content ml-4.5">{children}</span>
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  )
}

export { Button }
