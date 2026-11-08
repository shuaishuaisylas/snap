import type { ReactElement } from 'react'
import appIcon from '@/assets/models/snap.png'
import { APP_BRAND_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

interface BrandWordmarkProps {
  className?: string
}

/** 图标使用用户提供的原图，文字继承当前主题。 */
export function BrandWordmark({ className }: BrandWordmarkProps): ReactElement {
  return <span className={cn('inline-flex shrink-0 items-center gap-[0.25em] whitespace-nowrap font-semibold tracking-tight', className)}>
    <img src={appIcon} alt="" aria-hidden="true" draggable={false} className="h-[1.15em] w-[1.15em] object-contain" />
    <span>{APP_BRAND_NAME}</span>
  </span>
}
