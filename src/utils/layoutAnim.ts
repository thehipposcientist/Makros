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
    // Spring update gives the expand a livelier settle — feels like the
    // card "snaps" into its new size rather than creeping to it. Matches
    // the native-modal motion used elsewhere in the app. `springDamping`
    // is required when type is 'spring'; ~0.7 = moderate bounce.
    update:  { type: 'spring', springDamping: 0.7 },
    delete:  { type: 'easeInEaseOut', property: 'opacity' },
  });
}
