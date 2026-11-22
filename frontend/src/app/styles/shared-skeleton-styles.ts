import { css, unsafeCSS } from 'lit';
import skeletonCss from './shared-skeleton-styles.css?inline';

export const sharedSkeletonStyles = css`${unsafeCSS(skeletonCss)}`;
