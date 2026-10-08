'use strict';

const STATUS_LABELS = new Set(['requested', 'in_progress', 'in_review', 'completed', 'on_hold']);
const isLabelKind = kind => kind === 'status' || kind === 'category';
const labelKind = label => isLabelKind(label?.kind) ? label.kind : (STATUS_LABELS.has(typeof label === 'string' ? label : label?.id) ? 'status' : 'category');
const assignmentKind = (config, id) => labelKind(config.labels.find(label => label.id === id) || id);
const assignmentField = kind => kind === 'category' ? 'categoryAssignments' : 'assignments';

module.exports = {STATUS_LABELS, isLabelKind, labelKind, assignmentKind, assignmentField};
