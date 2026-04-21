/**
 * Shared layout-animation helper. Used in place of
 * `LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)`
 * because the built-in preset renders so fast in iOS release builds
 * that the motion is often imperceptible — users report "the expand
 * animation is gone".
 *
 * Explicit config with 350ms duration + clearly specified create/
 * update/delete types makes the transition legible on TestFlight
 * and production iOS, not just dev.
 */
import { LayoutAnimation } from 'react-native';

export function configureExpandAnimation(duration: number = 350) {
  LayoutAnimation.configureNext({
    duration,
    create:  { type: 'easeInEaseOut', property: 'opacity' },
    update:  { type: 'easeInEaseOut' },
    delete:  { type: 'easeInEaseOut', property: 'opacity' },
  });
}
