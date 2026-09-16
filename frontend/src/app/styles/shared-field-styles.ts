import { unsafeCSS } from "lit";
import fieldStyles from "./shared-field-styles.css?inline";

/** The same placeholder rules for Shadow DOM forms and the application stylesheet. */
export const sharedFieldStyles = unsafeCSS(fieldStyles);
