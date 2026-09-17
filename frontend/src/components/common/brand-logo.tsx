import logotype from '@/logotype.svg';
import { APP_NAME } from '@/lib/constants/app';
import { cn } from '@/lib/utils';

export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src={logotype}
      alt={APP_NAME}
      width={264}
      height={64}
      className={cn('h-10 w-auto', className)}
    />
  );
}
