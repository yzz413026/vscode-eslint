/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection, IConnection,
	ResponseError, RequestType, RequestHandler, NotificationType, NotificationHandler,
	InitializeResult, InitializeError,
	Diagnostic, DiagnosticSeverity, Position, Range, Files,
	TextDocuments, TextDocument, TextDocumentSyncKind, TextEdit, TextDocumentIdentifier,
	Command,
	ErrorMessageTracker, IPCMessageReader, IPCMessageWriter
} from 'vscode-languageserver';

import Uri from 'vscode-uri';

import fs = require('fs');
import path = require('path');

interface Map<V> {
	[key: string]: V;
}

interface ESLintError extends Error {
	messageTemplate?: string;
}

enum Status {
	ok = 1,
	warn = 2,
	error = 3
}

interface StatusParams {
	state: Status
}

namespace StatusNotification {
	export const type: NotificationType<StatusParams> = { get method() { return 'eslint/status'; } };
}

interface NoConfigParams {
	message: string;
	document: TextDocumentIdentifier;
}

interface NoConfigResult {
}

namespace NoConfigRequest {
	export const type: RequestType<NoConfigParams, NoConfigResult, void> = { get method() { return 'eslint/noConfig'; } };
}

interface NoESLintLibraryParams {
	source: TextDocumentIdentifier;
}

interface NoESLintLibraryResult {
}

namespace NoESLintLibraryRequest {
	export const type: RequestType<NoESLintLibraryParams, NoESLintLibraryResult, void> = { get method() { return 'eslint/noLibrary'; } };
}

class ID {
	private static base: string = `${Date.now().toString()}-`;
	private static counter: number = 0;
	public static next(): string {
		return `${ID.base}${ID.counter++}`
	}
}

type RunValues = 'onType' | 'onSave';

interface Settings {
	eslint: {
		enable: boolean;
		enableAutofixOnSave: boolean;
		options: any;
		run: RunValues;
	}
	[key: string]: any;
}

interface ESLintAutoFixEdit {
	range: [number, number];
	text: string;
}

interface ESLintProblem {
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	severity: number;
	ruleId: string;
	message: string;
	fix?: ESLintAutoFixEdit;
}

interface ESLintDocumentReport {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: ESLintProblem[];
	output?: string;
}

interface ESLintReport {
	errorCount: number;
	warningCount: number;
	results: ESLintDocumentReport[];
}

interface CLIEngine {
	executeOnText(content: string, file?:string): ESLintReport;
}

interface CLIEngineConstructor {
	new (options: any): CLIEngine;
}


interface ESLintModule {
	CLIEngine: CLIEngineConstructor;
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
	let message = (problem.ruleId != null)
		? `${problem.message} (${problem.ruleId})`
		: `${problem.message}`;
	let startLine = Math.max(0, problem.line - 1);
	let startChar = Math.max(0, problem.column - 1);
	let endLine = problem.endLine != null ? Math.max(0, problem.endLine - 1) : startLine;
	let endChar = problem.endColumn != null ? Math.max(0, problem.endColumn - 1) : startChar;
	return {
		message: message,
		severity: convertSeverity(problem.severity),
		source: 'eslint',
		range: {
			start: { line: startLine, character: startChar },
			end: { line: endLine, character: endChar }
		},
		code: problem.ruleId
	};
}

interface AutoFix {
	label: string;
	documentVersion: number;
	ruleId: string;
	edit: ESLintAutoFixEdit;
}

function computeKey(diagnostic: Diagnostic): string {
	let range = diagnostic.range;
	return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}`;
}

let codeActions: Map<Map<AutoFix>> = Object.create(null);
function recordCodeAction(document: TextDocument, diagnostic: Diagnostic, problem: ESLintProblem): void {
	if (!problem.fix || !problem.ruleId) {
		return;
	}
	let uri = document.uri;
	let edits: Map<AutoFix> = codeActions[uri];
	if (!edits) {
		edits = Object.create(null);
		codeActions[uri] = edits;
	}
	edits[computeKey(diagnostic)] = { label: `Fix this ${problem.ruleId} problem`, documentVersion: document.version, ruleId: problem.ruleId, edit: problem.fix};
}

function convertSeverity(severity: number): number {
	switch (severity) {
		// Eslint 1 is warning
		case 1:
			return DiagnosticSeverity.Warning;
		case 2:
			return DiagnosticSeverity.Error;
		default:
			return DiagnosticSeverity.Error;
	}
}

const exitCalled: NotificationType<[number, string]> = { method: 'eslint/exitCalled' };

const nodeExit = process.exit;
process.exit = (code?: number) => {
	let stack = new Error('stack');
	connection.sendNotification(exitCalled, [code ? code : 0, stack.stack]);
	setTimeout(() => {
		nodeExit(code);
	}, 1000);
}

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let settings: Settings = null;
let options: any = null;
let documents: TextDocuments = new TextDocuments();

let supportedLanguages: Map<boolean> = {
	'javascript': true,
	'javascriptreact': true
}

let globalNodePath: string = undefined;
let nodePath: string = undefined;
let workspaceRoot: string = undefined;

let path2Library: Map<ESLintModule> = Object.create(null);
let document2Library: Map<Thenable<ESLintModule>> = Object.create(null);

function ignoreTextDocument(document: TextDocument): boolean {
	return !supportedLanguages[document.languageId] || !document2Library[document.uri];
}

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
documents.onDidOpen((event) => {
	if (!supportedLanguages[event.document.languageId]) {
		return;
	}

	if (!document2Library[event.document.uri]) {
		let uri = Uri.parse(event.document.uri);
		let promise: Thenable<string>
		if (uri.scheme === 'file') {
			let file = uri.fsPath;
			let directory = path.dirname(file);
			if (nodePath) {
				 promise = Files.resolve('eslint', nodePath, nodePath, trace).then<string>(undefined, (error) => {
					 return Files.resolve('eslint', globalNodePath, directory, trace);
				 });
			} else {
				promise = Files.resolve('eslint', globalNodePath, directory, trace);
			}
		} else {
			promise = Files.resolve('eslint', globalNodePath, workspaceRoot, trace);
		}
		document2Library[event.document.uri] = promise.then((path) => {
			let library = path2Library[path];
			if (!library) {
				library = require(path);
				path2Library[path] = library;
			}
			if (!library.CLIEngine) {
				throw new Error(`The eslint library doesn\'t export a CLIEngine. You need at least eslint@1.0.0`);
			}
			connection.console.info(`ESLint library loaded from: ${path}`);
			return library;
		}, (error) => {
			connection.sendRequest(NoESLintLibraryRequest.type, { source: { uri: event.document.uri } });
			return null;
		});
	}
});

// A text document has changed. Validate the document according the run setting.
documents.onDidChangeContent((event) => {
	if (settings.eslint.run !== 'onType' || ignoreTextDocument(event.document)) {
		return;
	}
	validateSingle(event.document);
});

// A text document has been saved. Validate the document according the run setting.
documents.onDidSave((event) => {
	if (settings.eslint.run !== 'onSave' || ignoreTextDocument(event.document)) {
		return;
	}
	validateSingle(event.document);
});

documents.onDidClose((event) => {
	if (ignoreTextDocument(event.document)) {
		return;
	}
	delete document2Library[event.document.uri];
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

function trace(message: string, verbose?: string): void {
	connection.tracer.log(message, verbose);
}

connection.onInitialize((params): Thenable<InitializeResult | ResponseError<InitializeError>>  | InitializeResult | ResponseError<InitializeError> => {
	let initOptions: {
		legacyModuleResolve: boolean;
		nodePath: string;
	} = params.initializationOptions;
	workspaceRoot = params.rootPath;
	nodePath = initOptions.nodePath;
	globalNodePath = Files.resolveGlobalNodePath();
	return { capabilities: { textDocumentSync: documents.syncKind, codeActionProvider: true } };
});

function getMessage(err: any, document: TextDocument): string {
	let result: string = null;
	if (typeof err.message === 'string' || err.message instanceof String) {
		result = <string>err.message;
		result = result.replace(/\r?\n/g, ' ');
		if (/^CLI: /.test(result)) {
			result = result.substr(5);
		}
	} else {
		result = `An unknown error occured while validating file: ${Files.uriToFilePath(document.uri)}`;
	}
	return result;
}

function validate(document: TextDocument, library: ESLintModule): void {
	let cli = new library.CLIEngine(options);
	let content = document.getText();
	let uri = document.uri;
	// Clean previously computed code actions.
	delete codeActions[uri];
	let report: ESLintReport = cli.executeOnText(content, Files.uriToFilePath(uri));
	let diagnostics: Diagnostic[] = [];
	if (report && report.results && Array.isArray(report.results) && report.results.length > 0) {
		let docReport = report.results[0];
		if (docReport.messages && Array.isArray(docReport.messages)) {
			docReport.messages.forEach((problem) => {
				if (problem) {
					let diagnostic = makeDiagnostic(problem);
					diagnostics.push(diagnostic);
					recordCodeAction(document, diagnostic, problem);
				}
			});
		}
	}
	// Publish the diagnostics
	connection.sendDiagnostics({ uri, diagnostics });
}

let noConfigReported: Map<ESLintModule> = Object.create(null);

function isNoConfigFoundError(error: any): boolean {
	let candidate = error as ESLintError;
	return candidate.messageTemplate === 'no-config-found' || candidate.message === 'No ESLint configuration found.';
}

function tryHandleNoConfig(error: any, document: TextDocument, library: ESLintModule): Status {
	if (!isNoConfigFoundError(error)) {
		return undefined;
	}
	if (!noConfigReported[document.uri]) {
		connection.sendRequest(
			NoConfigRequest.type,
			{
				message: getMessage(error, document),
				document: {
					uri: document.uri
				}
			})
		.then(undefined, (error) => { });
		noConfigReported[document.uri] = library;
	}
	return Status.warn;
}

let configErrorReported: Map<ESLintModule> = Object.create(null);

function isConfigSyntaxError(err: any): boolean {
	return err.message && /^Cannot read config file:/.test(err.message);
}

function tryHandleConfigError(error: any, document: TextDocument, library: ESLintModule): Status {
	if (!error.message) {
		return undefined;
	}

	function handleFileName(filename: string): Status {
		if (!configErrorReported[filename]) {
			connection.console.warn(getMessage(error, document));
			if (!documents.get(Uri.file(filename).toString())) {
				connection.window.showInformationMessage(getMessage(error, document));
			}
			configErrorReported[filename] = library;
		}
		return Status.warn;
	}

	let filename: string = undefined;
	let matches = /Cannot read config file:\s+(.*)\nError:\s+(.*)/.exec(error.message);
	if (matches && matches.length === 3) {
		return handleFileName(matches[1]);
	}

	matches = /(.*):\n\s*Configuration for rule \"(.*)\" is /.exec(error.message);
	if (matches && matches.length === 3) {
		return handleFileName(matches[1]);
	}

	matches = /Cannot find module '([^']*)'\nReferenced from:\s+(.*)/.exec(error.message);
	if (matches && matches.length === 3) {
		return handleFileName(matches[2]);
	}

	return undefined;
}

function showErrorMessage(error: any, document: TextDocument, library: ESLintModule): Status {
	connection.window.showErrorMessage(getMessage(error, document));
	return Status.error;
}

const singleErrorHandlers: ((error: any, document: TextDocument, library: ESLintModule) => Status)[] = [
	tryHandleNoConfig,
	tryHandleConfigError,
	showErrorMessage
];

function validateSingle(document: TextDocument): void {
	document2Library[document.uri].then((library) => {
		if (!library) {
			return;
		}
		try {
			validate(document, library);
			connection.sendNotification(StatusNotification.type, { state: Status.ok });
		} catch (err) {
			let status = undefined;
			for (let handler of singleErrorHandlers) {
				status = handler(err, document, library);
				if (status) {
					break;
				}
			}
			status = status || Status.error;
			connection.sendNotification(StatusNotification.type, { state: status });
		}
	});
}

const manyErrorHandlers: ((error: any, document: TextDocument, library: ESLintModule) => Status)[] = [
	tryHandleNoConfig,
	tryHandleConfigError
];

function validateMany(documents: TextDocument[]): void {
	let tracker = new ErrorMessageTracker();
	let status = undefined;
	let promises: Thenable<void>[] = [];
	documents.forEach(document => {
		if (ignoreTextDocument(document)) {
			return;
		}
		promises.push(document2Library[document.uri].then((library) => {
			if (!library) {
				return;
			}
			try {
				validate(document, library);
			} catch (err) {
				let handled = false;
				for (let handler of manyErrorHandlers) {
					status = handler(err, document, library);
					if (status) {
						handled = true;
						break;
					}
				}
				if (!handled) {
					status = Status.error;
					tracker.add(getMessage(err, document));
				}
			}
		}));
	});
	Promise.all(promises).then(() => {
		tracker.sendErrors(connection);
		status = status || Status.ok;
		connection.sendNotification(StatusNotification.type, { state: status });
	}, (error) => {
		tracker.sendErrors(connection);
		connection.console.warn('Validating all open documents failed.');
		connection.sendNotification(StatusNotification.type, { state: Status.error });
	})
}

connection.onDidChangeConfiguration((params) => {
	settings = params.settings;
	if (settings.eslint) {
		options = settings.eslint.options || {};
	}
	// Settings have changed. Revalidate all documents.
	validateMany(documents.all());
});

connection.onDidChangeWatchedFiles((params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	noConfigReported = Object.create(null);
	params.changes.forEach((change) => {
		let fspath = Files.uriToFilePath(change.uri);
		let dirname = path.dirname(fspath);
		if (dirname) {
			let library = configErrorReported[fspath];
			if (library) {
				let cli = new library.CLIEngine(options);
				try {
					cli.executeOnText("", path.join(dirname, "___test___.js"));
					delete configErrorReported[fspath];
				} catch (error) {
				}
			}
		}
	});
	validateMany(documents.all());
});

class Fixes {
	private keys: string[];

	constructor (private edits: Map<AutoFix>) {
		this.keys = Object.keys(edits);
	}

	public static overlaps(lastEdit: AutoFix, newEdit: AutoFix): boolean {
		return !!lastEdit && lastEdit.edit.range[1] > newEdit.edit.range[0];
	}

	public isEmpty(): boolean {
		return this.keys.length === 0;
	}

	public getDocumentVersion(): number {
		return this.edits[this.keys[0]].documentVersion;
	}

	public getScoped(diagnostics: Diagnostic[]): AutoFix[] {
		let result: AutoFix[] = [];
		for(let diagnostic of diagnostics) {
			let key = computeKey(diagnostic);
			let editInfo = this.edits[key];
			if (editInfo) {
				result.push(editInfo);
			}
		}
		return result;
	}

	public getAllSorted(): AutoFix[] {
		let result = this.keys.map(key => this.edits[key]);
		return result.sort((a, b) => {
			let d = a.edit.range[0] - b.edit.range[0];
			if (d !== 0) {
				return d;
			}
			if (a.edit.range[1] === 0) {
				return -1;
			}
			if (b.edit.range[1] === 0) {
				return 1;
			}
			return a.edit.range[1] - b.edit.range[1];
		});
	}

	public getOverlapFree(): AutoFix[] {
		let sorted = this.getAllSorted();
		if (sorted.length <= 1) {
			return sorted;
		}
		let result: AutoFix[] = [];
		let last: AutoFix = sorted[0];
		result.push(last);
		for (let i = 1; i < sorted.length; i++) {
			let current = sorted[i];
			if (!Fixes.overlaps(last, current)) {
				result.push(current);
				last = current;
			}
		}
		return result;
	}
}

connection.onCodeAction((params) => {
	let result: Command[] = [];
	let uri = params.textDocument.uri;
	let edits = codeActions[uri];
	if (!edits) {
		return result;
	}

	let fixes = new Fixes(edits);
	if (fixes.isEmpty()) {
		return result;
	}

	let textDocument = documents.get(uri);
	let documentVersion: number = -1;
	let ruleId: string;

	function createTextEdit(editInfo: AutoFix): TextEdit {
		return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}

	function getLastEdit(array: AutoFix[]): AutoFix {
		let length = array.length;
		if (length === 0) {
			return undefined;
		}
		return array[length - 1];
	}

	for (let editInfo of fixes.getScoped(params.context.diagnostics)) {
		documentVersion = editInfo.documentVersion;
		ruleId = editInfo.ruleId;
		result.push(Command.create(editInfo.label, 'eslint.applySingleFix', uri, documentVersion, [
			createTextEdit(editInfo)
		]));
	};

	if (result.length > 0) {
		let same: AutoFix[] = [];
		let all: AutoFix[] = [];


		for (let editInfo of fixes.getAllSorted()) {
			if (documentVersion === -1) {
				documentVersion = editInfo.documentVersion;
			}
			if (editInfo.ruleId === ruleId && !Fixes.overlaps(getLastEdit(same), editInfo)) {
				same.push(editInfo);
			}
			if (!Fixes.overlaps(getLastEdit(all), editInfo)) {
				all.push(editInfo);
			}
		}
		if (same.length > 1) {
			result.push(Command.create(`Fix all ${ruleId} problems`, 'eslint.applySameFixes', uri, documentVersion, same.map(createTextEdit)));
		}
		if (all.length > 1) {
			result.push(Command.create(`Fix all auto-fixable problems`, 'eslint.applyAllFixes', uri, documentVersion, all.map(createTextEdit)));
		}
	}
	return result;
});

interface AllFixesParams {
	textDocument: TextDocumentIdentifier;
}

interface AllFixesResult {
	documentVersion: number,
	edits: TextEdit[]
}

namespace AllFixesRequest {
	export const type: RequestType<AllFixesParams, AllFixesResult, void> = { get method() { return 'textDocument/eslint/allFixes'; } };
}

connection.onRequest(AllFixesRequest.type, (params) => {
	let result: AllFixesResult = null;
	let uri = params.textDocument.uri;
	let textDocument = documents.get(uri);
	let edits = codeActions[uri];
	function createTextEdit(editInfo: AutoFix): TextEdit {
		return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
	}

	if (edits) {
		let fixes = new Fixes(edits);
		if (!fixes.isEmpty()) {
			result = {
				documentVersion: fixes.getDocumentVersion(),
				edits: fixes.getOverlapFree().map(createTextEdit)
			}
		}
	}
	return result;
});

connection.listen();