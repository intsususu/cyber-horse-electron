const horseIcon = new URL('../../../../assets/icon.png', import.meta.url).href

export function HorseMark({ className = '' }: { className?: string }) {
  return <img className={className} src={horseIcon} alt="" aria-hidden="true" draggable={false} />
}
