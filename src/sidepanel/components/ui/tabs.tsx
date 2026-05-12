import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../../../lib/utils";

export function Tabs({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("tabs", className)} {...props} />;
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("tabs-list", className)} {...props} />;
}

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function TabsTrigger({ active = false, className, ...props }: TabsTriggerProps) {
  return (
    <button
      className={cn("tabs-trigger", active && "tabs-trigger-active", className)}
      aria-pressed={active}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("tabs-content", className)} {...props} />;
}
