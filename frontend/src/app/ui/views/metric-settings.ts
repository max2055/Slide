import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import '../components/template-library.js';

@customElement('metric-settings')
export class MetricSettings extends LitElement {
  static styles = css`:host { display: block; min-width: 0; }`;

  override render() {
    return html`<template-library></template-library>`;
  }
}
