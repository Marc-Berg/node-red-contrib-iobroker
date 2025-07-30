(function(global) {
    'use strict';
    
    if (typeof global.ioBrokerSharedTreeView !== 'undefined' && global.ioBrokerSharedTreeView.initialized) {
        return;
    }
    
    const CONFIG = {
        ITEM_HEIGHT: 24,
        CHUNK_SIZE: 100,
        CACHE_DURATION: 5 * 60 * 1000
    };
    
    const cache = new Map();
    
    function injectStyles() {
        if (document.getElementById('iob-shared-styles-v2')) return;
        
        const style = document.createElement('style');
        style.id = 'iob-shared-styles-v2';
        style.textContent = `
            .iob-container { height: 320px; overflow-y: auto; border: 1px solid #ccc; border-radius: 4px; background: #fafafa; display: none; position: relative; }
            .iob-content { padding: 4px; }
            .iob-item { height: ${CONFIG.ITEM_HEIGHT}px; display: flex; align-items: center; padding: 0 8px; cursor: pointer; white-space: nowrap; border-radius: 3px; transition: background-color 0.15s ease; user-select: none; font-family: Monaco, monospace; font-size: 13px; margin-bottom: 1px; }
            .iob-item:hover { background-color: #e8f4f8; }
            .iob-item.selected { background-color: #d4edda; border-left: 3px solid #28a745; }
            .iob-item.selected.folder { background-color: #fff3cd; border-left: 3px solid #ffc107; }
            .iob-item.folder { font-weight: 500; }
            .iob-item.match { background-color: #fff3cd; border-left: 2px solid #ffc107; }
            .iob-item.path { background-color: #f8f9fa; border-left: 1px solid #dee2e6; }
            .iob-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; margin-right: 6px; font-size: 12px; flex-shrink: 0; }
            .iob-label { flex: 1; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
            .iob-label mark { background-color: #ffeb3b; padding: 1px 3px; border-radius: 2px; font-weight: bold; color: #333; }
            .iob-search { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; margin-bottom: 8px; }
            .iob-search:focus { outline: none; border-color: #4CAF50; box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2); }
            .iob-info { display: inline-block; margin-left: 8px; padding: 2px 8px; background-color: #d1ecf1; border: 1px solid #bee5eb; border-radius: 3px; font-size: 12px; color: #0c5460; font-family: Monaco, monospace; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
            .iob-info.folder { background-color: #fff3cd; border-color: #ffeaa7; color: #856404; }
            .iob-actions { display: flex; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #dee2e6; justify-content: flex-end; }
            .iob-status { padding: 6px 10px; border-radius: 3px; font-size: 12px; font-weight: 500; margin-top: 5px; display: inline-block; }
            .iob-status.success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .iob-status.info { background-color: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
            .iob-status.error { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            .iob-buttons { display: flex; gap: 8px; margin-top: 5px; }
            .iob-btn { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; font-size: 12px; transition: all 0.2s ease; }
            .iob-btn:hover { background: #f8f9fa; border-color: #adb5bd; }
            .iob-btn.primary { background: #007bff; color: white; border-color: #007bff; }
            .iob-btn.primary:hover { background: #0056b3; }
            .iob-btn.success { background: #28a745; color: white; border-color: #28a745; }
            .iob-btn.success:hover { background: #1e7e34; }
            .iob-btn:disabled { background: #6c757d; border-color: #6c757d; cursor: not-allowed; opacity: 0.6; }
            .iob-stats { font-size: 11px; color: #6c757d; margin-top: 4px; font-style: italic; }
            .iob-empty { padding: 40px 20px; text-align: center; color: #666; font-style: italic; background: #f8f9fa; border-radius: 4px; margin: 20px; }
            .wildcard-disabled { opacity: 0.6; }
            .wildcard-disabled label { color: #999 !important; }
            .wildcard-disabled input:disabled { opacity: 0.5; cursor: not-allowed; }
        `;
        document.head.appendChild(style);
    }
    
    // Simplified cache utilities
    const CacheManager = {
        get: (serverId) => {
            const entry = cache.get(serverId);
            return (entry && (Date.now() - entry.timestamp) < CONFIG.CACHE_DURATION) ? entry.data : null;
        },
        set: (serverId, data) => cache.set(serverId, { data, timestamp: Date.now() }),
        clear: (serverId) => serverId ? cache.delete(serverId) : cache.clear(),
        getCacheBreaker: () => `cb=${Date.now()}`
    };
    
    // Simplified wildcard utilities
    const WildcardUtils = {
        detect: (pattern) => ({
            isWildcard: pattern?.includes('*') || false,
            hasUnsupported: pattern?.includes('?') || false,
            warning: pattern?.includes('?') ? 'Use * instead of ?' : null
        }),
        
        showInfo: (nodeType, warnings = []) => {
            let info = $(`#wildcard-info-${nodeType}`);
            if (!info.length) {
                info = $(`<div id="wildcard-info-${nodeType}"></div>`);
                $(`#node-input-${nodeType === 'iobin' ? 'state' : nodeType.replace('iob', '')}`).after(info);
            }
            
            const warningText = warnings.length ? `<div style="color: #f39c12; margin-top: 5px;"><i class="fa fa-exclamation-triangle"></i> ${warnings.join('; ')}</div>` : '';
            info.html(`
                <div style="background: #e8f4fd; border: 1px solid #bee5eb; border-radius: 4px; padding: 10px; font-size: 13px; color: #0c5460; margin-top: 5px;">
                    <i class="fa fa-info-circle" style="color: #17a2b8; margin-right: 5px;"></i>
                    <strong>Wildcard Mode:</strong> * matches any characters, ? not supported
                    ${warningText}
                </div>
            `).show();
        },
        
        hide: (nodeType) => $(`#wildcard-info-${nodeType}`).hide()
    };
    
    class TreeData {
        constructor() {
            this.nodes = new Map();
            this.roots = [];
            this.filtered = [];
            this.searchIndex = new Map();
            this.searchTerm = '';
            this.searchMode = false;
        }
        
        async buildFromStates(states) {
            this.clear();
            const stateIds = Object.keys(states);
            
            // Process in chunks for performance
            for (let i = 0; i < stateIds.length; i += CONFIG.CHUNK_SIZE) {
                this.processChunk(stateIds.slice(i, i + CONFIG.CHUNK_SIZE));
                if (i % (CONFIG.CHUNK_SIZE * 5) === 0) await new Promise(r => setTimeout(r, 0));
            }
            
            this.buildHierarchy();
            this.buildSearchIndex();
            this.updateFiltered();
        }
        
        processChunk(stateIds) {
            stateIds.forEach(stateId => {
                const segments = stateId.split('.');
                let path = '';
                
                segments.forEach((segment, i) => {
                    const parent = path;
                    path = path ? `${path}.${segment}` : segment;
                    
                    if (!this.nodes.has(path)) {
                        const isLeaf = i === segments.length - 1;
                        this.nodes.set(path, {
                            id: path, label: segment, fullId: isLeaf ? stateId : null, isLeaf,
                            depth: i, parent: parent || null, children: [], expanded: false,
                            visible: true, isMatch: false, isPathToMatch: false
                        });
                    }
                });
            });
        }
        
        buildHierarchy() {
            // Build parent-child relationships and sort
            for (const [nodeId, node] of this.nodes) {
                if (node.parent) {
                    const parent = this.nodes.get(node.parent);
                    if (parent && !parent.children.includes(nodeId)) parent.children.push(nodeId);
                }
            }
            
            for (const node of this.nodes.values()) {
                node.children.sort((a, b) => {
                    const nodeA = this.nodes.get(a), nodeB = this.nodes.get(b);
                    if (nodeA.isLeaf !== nodeB.isLeaf) return nodeA.isLeaf ? 1 : -1;
                    return nodeA.label.localeCompare(nodeB.label, undefined, { numeric: true });
                });
            }
            
            this.roots = Array.from(this.nodes.values())
                .filter(n => !n.parent)
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
                .map(n => n.id);
        }
        
        buildSearchIndex() {
            this.searchIndex.clear();
            for (const [nodeId, node] of this.nodes) {
                const terms = new Set([node.label.toLowerCase(), nodeId.toLowerCase()]);
                nodeId.split('.').forEach(segment => terms.add(segment.toLowerCase()));
                
                terms.forEach(term => {
                    if (!this.searchIndex.has(term)) this.searchIndex.set(term, new Set());
                    this.searchIndex.get(term).add(nodeId);
                });
            }
        }
        
        search(term) {
            this.searchTerm = term.trim();
            this.searchMode = this.searchTerm.length > 0;
            
            // Reset all nodes
            for (const node of this.nodes.values()) {
                node.visible = true;
                node.isMatch = false;
                node.isPathToMatch = false;
                if (this.searchMode) node.expanded = false;
            }
            
            if (!this.searchMode) {
                this.updateFiltered();
                return { results: [], total: this.filtered.length };
            }
            
            // Find matches and mark paths
            const matches = this.findMatches(this.searchTerm);
            matches.forEach(nodeId => {
                const node = this.nodes.get(nodeId);
                if (node) {
                    node.isMatch = true;
                    this.markPathToRoot(nodeId);
                }
            });
            
            // Filter and expand
            this.filterForSearch();
            this.expandPathsToMatches();
            this.updateFiltered();
            
            return { results: matches, total: this.filtered.length, searchTerm: this.searchTerm };
        }
        
        findMatches(term) {
            const results = new Set();
            const lower = term.toLowerCase();
            
            for (const [indexTerm, nodeIds] of this.searchIndex) {
                if (indexTerm.includes(lower)) nodeIds.forEach(id => results.add(id));
            }
            
            return Array.from(results);
        }
        
        markPathToRoot(nodeId) {
            let current = this.nodes.get(nodeId);
            while (current?.parent) {
                const parent = this.nodes.get(current.parent);
                if (parent && !parent.isMatch) parent.isPathToMatch = true;
                current = parent;
            }
        }
        
        filterForSearch() {
            for (const node of this.nodes.values()) {
                node.visible = node.isMatch || node.isPathToMatch || this.hasMatchingChildren(node.id);
            }
        }
        
        hasMatchingChildren(nodeId) {
            const node = this.nodes.get(nodeId);
            if (!node || node.isLeaf) return false;
            return node.children.some(childId => {
                const child = this.nodes.get(childId);
                return child && (child.isMatch || this.hasMatchingChildren(childId));
            });
        }
        
        expandPathsToMatches() {
            for (const node of this.nodes.values()) {
                if (node.isPathToMatch && !node.isLeaf) node.expanded = true;
            }
        }
        
        updateFiltered() {
            this.filtered = [];
            this.roots.forEach(rootId => this.addToFiltered(rootId));
        }
        
        addToFiltered(nodeId) {
            const node = this.nodes.get(nodeId);
            if (!node || !node.visible) return;
            
            this.filtered.push({
                ...node, index: this.filtered.length,
                isSearchMatch: node.isMatch, isSearchPath: node.isPathToMatch
            });
            
            if (node.expanded) node.children.forEach(childId => this.addToFiltered(childId));
        }
        
        toggle(nodeId) {
            const node = this.nodes.get(nodeId);
            if (node && !node.isLeaf) {
                node.expanded = !node.expanded;
                this.updateFiltered();
                return true;
            }
            return false;
        }
        
        collapseAll() {
            for (const node of this.nodes.values()) {
                if (!node.isLeaf) node.expanded = false;
            }
            this.updateFiltered();
        }
        
        clear() {
            this.nodes.clear();
            this.roots = [];
            this.filtered = [];
            this.searchIndex.clear();
            this.searchTerm = '';
            this.searchMode = false;
        }
    }
    
    class TreeView {
        constructor(container, data) {
            this.container = container;
            this.data = data;
            this.selectedId = null;
            this.onSelected = null;
            this.onChanged = null;
            this.init();
        }
        
        init() {
            this.container.innerHTML = '<div class="iob-content"></div>';
            this.content = this.container.querySelector('.iob-content');
            this.content.addEventListener('click', e => this.handleClick(e));
            this.content.addEventListener('dblclick', e => this.handleDoubleClick(e));
        }
        
        render() {
            const nodes = this.data.filtered;
            if (!nodes.length) {
                this.content.innerHTML = `<div class="iob-empty">${this.data.searchMode ? `No results for "${this.data.searchTerm}"` : 'No items'}</div>`;
                return;
            }
            
            this.content.innerHTML = nodes.map(node => this.createNodeHTML(node)).join('');
        }
        
        createNodeHTML(node) {
            const classes = ['iob-item', node.isLeaf ? 'leaf' : 'folder'];
            if (node.isSearchMatch) classes.push('match');
            else if (node.isSearchPath) classes.push('path');
            if (node.id === this.selectedId) classes.push('selected');
            
            const icon = node.isLeaf ? '🔗' : (node.expanded ? '📂' : '📁');
            const label = this.highlightSearch(node.label);
            const padding = (node.depth * 16) + 8;
            
            return `<div class="${classes.join(' ')}" data-id="${node.id}" style="padding-left:${padding}px">
                <span class="iob-icon">${icon}</span>
                <span class="iob-label" title="${node.id}">${label}</span>
            </div>`;
        }
        
        highlightSearch(text) {
            if (!this.data.searchMode || !this.data.searchTerm) return text;
            const term = this.data.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return text.replace(new RegExp(`(${term})`, 'gi'), '<mark>$1</mark>');
        }
        
        handleClick(e) {
            const item = e.target.closest('.iob-item');
            if (!item) return;
            
            const nodeId = item.dataset.id;
            this.container.querySelectorAll('.iob-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            this.selectedId = nodeId;
            
            if (this.onChanged) this.onChanged(this.data.nodes.get(nodeId));
            if (this.data.toggle(nodeId)) this.render();
        }
        
        handleDoubleClick(e) {
            const item = e.target.closest('.iob-item');
            if (!item) return;
            
            const node = this.data.nodes.get(item.dataset.id);
            if (node?.isLeaf && this.onSelected) {
                this.onSelected(node.fullId || node.id);
            } else if (node && !node.isLeaf) {
                this.data.toggle(node.id);
                this.render();
            }
        }
        
        search(term) {
            const results = this.data.search(term);
            this.render();
            return results;
        }
        
        setSelected(nodeId) {
            this.selectedId = nodeId;
            if (this.onChanged) this.onChanged(this.data.nodes.get(nodeId));
        }
        
        getSelected() {
            return this.selectedId ? this.data.nodes.get(this.selectedId) : null;
        }
        
        destroy() {
            this.container.innerHTML = '';
        }
    }
    
    function createTreeView(config) {
        const { nodeType, inputId, serverInputId, searchPlaceholder = "Search...", itemType = "items", dataEndpoint = "/iobroker/ws/states", enableWildcardDetection = false, wildcardInputId = null } = config;
        
        injectStyles();
        
        const stateInput = $('#' + inputId);
        const serverInput = $('#' + serverInputId);
        const stateLabel = $(`label[for="${inputId}"]`);
        
        if (!stateInput.length || !serverInput.length) throw new Error('Required inputs not found');
        
        // Create UI elements
        const elements = {
            container: $('<div class="iob-container"></div>'),
            searchContainer: $(`<div style="display:none;"><input type="text" class="iob-search" placeholder="${searchPlaceholder}"></div>`),
            actions: $(`<div class="iob-actions" style="display:none;"><button type="button" class="iob-btn success" disabled><i class="fa fa-check"></i> Use</button><button type="button" class="iob-btn"><i class="fa fa-times"></i> Cancel</button></div>`),
            buttons: $(`<div class="iob-buttons"><button type="button" class="iob-btn primary">Tree View</button><button type="button" class="iob-btn refresh-btn"><i class="fa fa-refresh"></i> Refresh</button><button type="button" class="iob-btn clear-btn"><i class="fa fa-times"></i> Clear</button></div>`),
            status: $('<div class="iob-status"></div>'),
            stats: $('<div class="iob-stats"></div>')
        };
        
        // Insert elements
        stateInput.after(elements.stats).after(elements.status).after(elements.actions).after(elements.container).after(elements.searchContainer).after(elements.buttons);
        
        // Get references
        const toggleBtn = elements.buttons.find('.primary');
        const refreshBtn = elements.buttons.find('.refresh-btn');
        const clearBtn = elements.buttons.find('.clear-btn');
        
        // Initially hide refresh and clear buttons
        refreshBtn.hide();
        clearBtn.hide();
        const searchInput = elements.searchContainer.find('.iob-search');
        const useBtn = elements.actions.find('.success');
        const cancelBtn = elements.actions.find(':not(.success)');
        
        // State
        const treeData = new TreeData();
        let treeView = null;
        let currentServerId = null;
        let dataLoaded = false;
        let searchTimeout = null;
        let selectedId = null;
        
        // Wildcard detection
        if (enableWildcardDetection && wildcardInputId) {
            stateInput.on('input keyup change', function() {
                const info = WildcardUtils.detect($(this).val());
                const checkbox = $('#' + wildcardInputId);
                
                if (info.isWildcard) {
                    WildcardUtils.showInfo(nodeType, info.warning ? [info.warning] : []);
                    if (checkbox.length) {
                        checkbox.prop('checked', false).prop('disabled', true);
                        checkbox.closest('.form-row').addClass('wildcard-disabled');
                    }
                } else {
                    WildcardUtils.hide(nodeType);
                    if (checkbox.length) {
                        checkbox.prop('disabled', false);
                        checkbox.closest('.form-row').removeClass('wildcard-disabled');
                    }
                }
            });
        }
        
        // Helper functions
        function updateSelection(node) {
            if (node?.isLeaf) {
                selectedId = node.fullId || node.id;
                updateLabel(selectedId, false);
                useBtn.prop('disabled', false);
            } else if (node && !node.isLeaf) {
                selectedId = node.id;
                updateLabel(selectedId + ' (folder)', true);
                useBtn.prop('disabled', true);
            } else {
                selectedId = null;
                updateLabel(null);
                useBtn.prop('disabled', true);
            }
        }
        
        function updateLabel(text, isFolder = false) {
            stateLabel.find('.iob-info').remove();
            if (text) {
                const info = $(`<span class="iob-info${isFolder ? ' folder' : ''}" title="${text}">${text}</span>`);
                stateLabel.append(info);
            }
        }
        
        function findAndSelect(stateId) {
            if (!stateId || !treeData) return false;
            const node = treeData.nodes.get(stateId);
            if (node) {
                expandToNode(stateId);
                treeView?.setSelected(stateId);
                return true;
            }
            return false;
        }
        
        function expandToNode(nodeId) {
            let current = nodeId;
            const toExpand = [];
            while (current) {
                const node = treeData.nodes.get(current);
                if (!node) break;
                if (node.parent) toExpand.unshift(node.parent);
                current = node.parent;
            }
            toExpand.forEach(id => {
                const node = treeData.nodes.get(id);
                if (node && !node.isLeaf) node.expanded = true;
            });
            treeData.updateFiltered();
        }
        
        async function loadData(forceRefresh = false) {
            const serverNode = RED.nodes.node(serverInput.val());
            if (!serverNode) return showStatus('error', 'No server selected');
            
            const serverId = `${serverNode.iobhost}:${serverNode.iobport}`;
            currentServerId = serverId;
            
            if (!forceRefresh) {
                const cached = CacheManager.get(serverId);
                if (cached) return renderData(cached, true);
            }
            
            if (forceRefresh) CacheManager.clear(serverId);
            
            try {
                showStatus('info', `Loading ${itemType}...`);
                elements.container.html(`<div style="padding:20px;text-align:center"><i class="fa fa-spinner fa-spin"></i> Loading...</div>`);
                
                let url = `${dataEndpoint}/${encodeURIComponent(serverId)}`;
                if (forceRefresh) url += `?${CacheManager.getCacheBreaker()}`;
                
                const data = await $.ajax({
                    url, method: 'GET', timeout: 20000, dataType: 'json', cache: false,
                    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache', 'Expires': '0' }
                });
                
                if (!Object.keys(data).length) throw new Error(`No ${itemType} received`);
                CacheManager.set(serverId, data);
                renderData(data, false);
            } catch (error) {
                showStatus('error', `Error: ${error.message}`);
            }
        }
        
        async function renderData(data, cached) {
            await treeData.buildFromStates(data);
            if (treeView) treeView.destroy();
            
            treeView = new TreeView(elements.container[0], treeData);
            treeView.onChanged = updateSelection;
            treeView.onSelected = (itemId) => {
                stateInput.val(itemId).trigger('change');
                RED.notify?.(`Selected: ${itemId}`, { type: "success", timeout: 2000 });
                setTimeout(toggleMode, 300);
            };
            
            const existing = stateInput.val().trim();
            if (existing) findAndSelect(existing);
            
            treeView.render();
            dataLoaded = true;
            showStatus('success', `Loaded ${Object.keys(data).length} ${itemType} ${cached ? '(cached)' : ''}`);
        }
        
        function showStatus(type, msg) {
            const icons = { success: 'fa-check-circle', info: 'fa-info-circle', error: 'fa-exclamation-triangle' };
            // Escape HTML to prevent XSS
            const escapedMsg = $('<div>').text(msg).html();
            elements.status.html(`<span class="iob-status ${type}"><i class="fa ${icons[type]}"></i> ${escapedMsg}</span>`).show();
        }
        
        function toggleMode() {
            const isManual = stateInput.is(':visible');
            stateInput.toggle(!isManual);
            elements.container.toggle(isManual);
            elements.searchContainer.toggle(isManual);
            elements.actions.toggle(isManual);
            
            // Show refresh and clear buttons only when tree is active
            refreshBtn.toggle(isManual);
            clearBtn.toggle(isManual);
            
            if (!isManual) {
                elements.status.hide();
                elements.stats.hide();
                updateSelection(null);
            } else {
                const existing = stateInput.val().trim();
                if (existing && dataLoaded) {
                    setTimeout(() => {
                        findAndSelect(existing);
                        treeView?.render();
                    }, 100);
                }
            }
            
            toggleBtn.text(isManual ? 'Manual Input' : 'Tree View');
            if (isManual && !dataLoaded) loadData();
        }
        
        // Event handlers
        toggleBtn.on('click', toggleMode);
        useBtn.on('click', () => {
            if (selectedId && treeView) {
                const node = treeView.getSelected();
                if (node?.isLeaf) {
                    stateInput.val(node.fullId || node.id).trigger('change');
                    RED.notify?.(`Selected: ${node.fullId || node.id}`, { type: "success", timeout: 2000 });
                    toggleMode();
                } else {
                    RED.notify?.('Folders cannot be selected', { type: "warning", timeout: 2000 });
                }
            }
        });
        cancelBtn.on('click', toggleMode);
        
        refreshBtn.on('click', function() {
            if (!currentServerId) return;
            searchInput.val('').trigger('input');
            elements.stats.hide();
            updateSelection(null);
            CacheManager.clear(currentServerId);
            
            const icon = $(this).find('i');
            icon.addClass('fa-spin');
            $(this).text(' Refreshing...').addClass('refreshing');
            
            loadData(true).finally(() => {
                setTimeout(() => {
                    icon.removeClass('fa-spin');
                    $(this).html('<i class="fa fa-refresh"></i> Refresh').removeClass('refreshing');
                }, 1000);
            });
            
            RED.notify?.(`Refreshing ${itemType}...`, { type: "warning", timeout: 3000 });
        });
        
        clearBtn.on('click', () => {
            searchInput.val('').trigger('input');
            if (treeData && treeView) {
                treeData.collapseAll();
                treeView.render();
                updateSelection(null);
                RED.notify?.('Cleared and collapsed', { type: "info", timeout: 2000 });
            }
            searchInput.focus();
        });
        
        searchInput.on('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                if (treeView && treeData) {
                    const results = treeView.search($(this).val().trim());
                    elements.stats.html(results.searchTerm ? 
                        `Found ${results.results.length} matches for "${results.searchTerm}"` : 
                        `Showing all ${itemType}`
                    ).toggle(!!results.searchTerm);
                }
            }, 200);
        });
        
        serverInput.on('change', () => {
            treeData.clear();
            if (treeView) { treeView.destroy(); treeView = null; }
            dataLoaded = false;
            elements.status.empty();
            elements.stats.hide();
            updateSelection(null);
            if (currentServerId) loadData();
        });
        
        return {
            cleanup: () => {
                if (treeView) treeView.destroy();
                clearTimeout(searchTimeout);
                Object.values(elements).forEach(el => el.remove());
                updateLabel(null);
                stateInput.show();
                WildcardUtils.hide(nodeType);
                $(`#wildcard-info-${nodeType}`).remove();
            }
        };
    }
    
    global.ioBrokerSharedTreeView = {
        version: '1.5.0',
        setup: createTreeView,
        TreeData, TreeView, CacheManager, WildcardUtils,
        initialized: true
    };
    
})(window);