// jsdom has no native dialog lifecycle. Keyboard/inert semantics are verified in Playwright.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
