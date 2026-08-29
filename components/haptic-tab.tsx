import { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { PlatformPressable } from '@react-navigation/elements';
import { hTap } from '@/utils/haptics';

export function HapticTab(props: BottomTabBarButtonProps) {
  return (
    <PlatformPressable
      {...props}
      onPressIn={(ev) => {
        // A firm tap when switching tabs (Medium impact via hTap).
        hTap();
        props.onPressIn?.(ev);
      }}
    />
  );
}
