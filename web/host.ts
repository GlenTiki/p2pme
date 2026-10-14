const instruction =
  document.querySelector<HTMLTextAreaElement>("#host-instruction");
const button = document.querySelector<HTMLButtonElement>(
  "#copy-host-instruction",
);
const copyStatus = document.querySelector<HTMLElement>("#host-copy-status");

if (instruction && button && copyStatus) {
  button.addEventListener("click", async () => {
    copyStatus.textContent = "";
    try {
      await navigator.clipboard.writeText(instruction.value);
      copyStatus.textContent = "Instruction copied.";
    } catch {
      instruction.focus();
      instruction.select();
      instruction.setSelectionRange(0, instruction.value.length);
      copyStatus.textContent = "Copy failed. Copy the selected text manually.";
    }
  });
  button.parentElement!.hidden = false;
}
