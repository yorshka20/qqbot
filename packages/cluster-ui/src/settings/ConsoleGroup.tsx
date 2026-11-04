import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { setTheme, type ThemeChoice, useThemeChoice } from '../app/theme';
import { signOut } from '../auth/session';
import { Button } from '../components/ui/button';

const THEMES: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'dark', label: '深色', Icon: Moon },
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'system', label: '跟随系统', Icon: Monitor },
];

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'j / k', action: '在列表里上下移动' },
  { keys: 'Enter', action: '打开选中的行' },
  { keys: 'n', action: '新建任务' },
  { keys: '/', action: '搜索任务' },
  { keys: 'Esc', action: '返回上一级' },
  { keys: '⌘Enter', action: '提交输入框里的内容' },
];

export function ConsoleGroup() {
  const theme = useThemeChoice();
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">主题</h2>
        <div className="flex flex-wrap gap-2">
          {THEMES.map(({ value, label, Icon }) => (
            <Button
              key={value}
              variant={theme === value ? 'default' : 'outline'}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <Icon />
              {label}
            </Button>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">快捷键</h2>
        <dl className="flex flex-col gap-1.5">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={keys} className="flex items-baseline gap-3 text-sm">
              <dt className="w-20 shrink-0 font-mono text-xs">{keys}</dt>
              <dd className="text-muted-foreground">{action}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">这台设备</h2>
        <div>
          <Button variant="outline" onClick={() => signOut()}>
            <LogOut />
            退出控制台
          </Button>
        </div>
      </section>
    </div>
  );
}
