<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { EditorState } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { spiceLanguage } from './spice-language';
	import { spiceEditorTheme, spiceSyntaxHighlighting } from './spice-theme';

	let { value = $bindable(''), onchange }: { value: string; onchange?: (value: string) => void } = $props();

	let editorContainer: HTMLDivElement;
	let view: EditorView | null = null;
	let applyingExternal = false;
	const toEditor = (text: string) => text.replace(/\r\n?/g, '\n');

	onMount(() => {
		const updateListener = EditorView.updateListener.of((update) => {
			// a text set from outside is not an edit (and must not lose its line endings)
			if (update.docChanged && !applyingExternal) {
				const text = update.state.doc.toString();
				// CodeMirror works in \n; a Windows file stays a Windows file
				const newValue = value.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
				value = newValue;
				onchange?.(newValue);
			}
		});

		const state = EditorState.create({
			doc: value,
			extensions: [
				lineNumbers(),
				highlightActiveLine(),
				highlightActiveLineGutter(),
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				spiceLanguage,
				spiceEditorTheme,
				spiceSyntaxHighlighting,
				updateListener,
				EditorView.lineWrapping
			]
		});

		view = new EditorView({
			state,
			parent: editorContainer
		});
	});

	onDestroy(() => {
		view?.destroy();
	});

	// Sync external value changes to editor
	$effect(() => {
		if (view && toEditor(value) !== view.state.doc.toString()) {
			applyingExternal = true;
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: toEditor(value) }
			});
			applyingExternal = false;
		}
	});
</script>

<div class="editor-wrapper" bind:this={editorContainer}></div>

<style>
	.editor-wrapper {
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.editor-wrapper :global(.cm-editor) {
		height: 100%;
	}

	.editor-wrapper :global(.cm-scroller) {
		overflow: auto;
	}
</style>

