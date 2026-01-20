// ==UserScript==
// @name         Handelsbanken - Spara kontoutdrag som CSV
// @namespace    https://spadrig.se/tampermonkey
// @version      0.2
// @description  Adds menu item to export account transactions as CSV
// @match        https://secure.handelsbanken.se/*
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
	'use strict';
console.log("test");
	const TARGET_PATH = '/se/private/sv/accounts_and_cards/account_transactions';
	const NEWLINE = '\r\n';
	const ROW_CELL_COUNT = 5;

	const isOnAccountTransactionsPage = () => {
		const url = new URL(window.location.href);
		return url.pathname === TARGET_PATH;
	};

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	const waitForTableUpdate = async (table, previousSignature) => {
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const currentSignature = table.querySelector('tbody>tr')?.textContent || '';
			if (currentSignature && currentSignature !== previousSignature) {
				return true;
			}
			await sleep(200);
		}
		return false;
	};

	const exportTableAsCsv = async () => {
		const table = document.querySelector('table.shb-table');
		if (!table) {
			console.warn('Hittade ingen tabell för kontoutdrag.');
			return;
		}

		const outputRows = [
			Array.from(table.querySelectorAll('th'))
				.map((node) => node.textContent)
				.filter(Boolean)
				.join(';'),
		];

		const pages = document.querySelectorAll(
			'.shb-paginator__page-select>.shb-paginator__page-item'
		);

		const clickPage = async (index) => {
			const button = pages[index]?.querySelector('button');
			if (!button) {
				return false;
			}
			const previousSignature = table.querySelector('tbody>tr')?.textContent || '';
			button.click();
			await waitForTableUpdate(table, previousSignature);
			return true;
		};

		let currentPageNum = 0;
		if (pages.length) {
			await clickPage(0);
		}

		const collectRows = () => {
			for (const row of table.querySelectorAll('tbody>tr')) {
				const cells = row.querySelectorAll('td');
				let outputRow = '';
				for (let i = 0; i < ROW_CELL_COUNT && i < cells.length; i += 1) {
					outputRow += cells[i].textContent;
					if (i < ROW_CELL_COUNT - 1) {
						outputRow += ';';
					}
				}
				outputRows.push(outputRow);
			}
		};

		do {
			collectRows();
			currentPageNum += 1;
		} while (pages.length && currentPageNum < pages.length && (await clickPage(currentPageNum)));

		const result = outputRows.join(NEWLINE);
		const blob = new Blob([result], { type: 'text/csv;charset=utf-8;' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `kontoutdrag-${new Date().toISOString().slice(0, 10)}.csv`;
		link.click();
		URL.revokeObjectURL(url);
	};

	GM_registerMenuCommand('Spara kontoutdrag som CSV', () => {
		if (isOnAccountTransactionsPage()) {
			void exportTableAsCsv();
		} else {
			console.log('❌ Fel sida');
			console.log('Nuvarande URL:', window.location.href);
		}
	});
})();

