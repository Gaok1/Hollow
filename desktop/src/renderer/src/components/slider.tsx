import { useEffect, useState } from 'react'

interface SliderProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
  title?: string
}

/**
 * A range input that does not fight the hand dragging it.
 *
 * The mixer's numbers come back from the daemon ten times a second, and a
 * controlled input whose `value` is re-set from a snapshot taken before the
 * current drag frame snaps the thumb back to where the drag started. What that
 * looks like is a slider that ignores being dragged and only answers to a click
 * on the spot the thumb should already be — which is exactly the bug this
 * fixes.
 *
 * So while the gesture is in progress the local value wins outright, and the
 * outside value is adopted again only once the pointer is off it. Release is
 * tracked on the window rather than the element: a drag that ends with the
 * pointer somewhere else still ends.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 0.01,
  disabled,
  id,
  className = 'slider',
  ...rest
}: SliderProps) {
  const [dragging, setDragging] = useState(false)
  const [local, setLocal] = useState(value)

  useEffect(() => {
    if (!dragging) setLocal(value)
  }, [value, dragging])

  useEffect(() => {
    if (!dragging) return
    const end = () => setDragging(false)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [dragging])

  return (
    <input
      {...rest}
      id={id}
      className={className}
      type="range"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={dragging ? local : value}
      onPointerDown={() => setDragging(true)}
      onChange={(event) => {
        const next = Number(event.target.value)
        setLocal(next)
        onChange(next)
      }}
    />
  )
}
