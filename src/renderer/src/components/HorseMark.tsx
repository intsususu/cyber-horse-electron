export function HorseMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        d="M9 42c0-9 3-15 10-21l-5-3 6-10 7 3 5-7 2 11 10 10-3 7-9-1-4-5c-4 5-5 10-4 16H9Zm22-24-4-1 2 4 2-3Z"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
      />
      <path d="m16 9-5 3-7 14h6l6-10-3-2 3-5ZM8 29l-4 9h3l3-9H8Z" fill="currentColor" />
    </svg>
  )
}
