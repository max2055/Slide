import { css, unsafeCSS } from 'lit';
import buttonCss from './shared-btn-styles.css?inline';

/** One stylesheet for document and shadow roots; appearance tokens inherit. */
export const sharedBtnStyles = css`${unsafeCSS(buttonCss)}`;
