// Ported from Process GPT vue3 frontend — process-gpt/services/frontend/src/components/autoLayout/sequence-flow-final-connection-docking.js @ 0e85995b.
// Copied as is for Lite's BPMN views (src/lib/bpmn-auto-layout/index.js); changes here are marked "Lite:".
/**
 * diagram-js CroppingConnectionDocking.js 원문 그대로 복사.
 * 유일한 변경: `./LayoutUtil` → `diagram-js/lib/layout/LayoutUtil`
 * 추가: 긴 polyline만 delegate 힌트용으로 일시 decimate 하되, 반환 결과는 visual crop only 로 유지
 *
 * 원본: node_modules/diagram-js/lib/layout/CroppingConnectionDocking.js
 */
import { assign } from 'min-dash';

import { getElementLineIntersection } from 'diagram-js/lib/layout/LayoutUtil';

import { decimateWaypointsToMax, MAX_BPMN_DELEGATE_WAYPOINT_HINT } from './sequence-flow-final-layouter.js';

function dockingToPoint(docking) {
    // use the dockings actual point and
    // retain the original docking
    return assign({ original: docking.point.original || docking.point }, docking.actual);
}

/**
 * A {@link ConnectionDocking} that crops connection waypoints based on
 * the path(s) of the connection source and target.
 *
 * @param {ElementRegistry} elementRegistry
 * @param {GraphicsFactory} graphicsFactory
 */
export default function CroppingConnectionDocking(elementRegistry, graphicsFactory) {
    this._elementRegistry = elementRegistry;
    this._graphicsFactory = graphicsFactory;
}

CroppingConnectionDocking.$inject = ['elementRegistry', 'graphicsFactory'];

/**
 * @inheritDoc ConnectionDocking#getCroppedWaypoints
 */
CroppingConnectionDocking.prototype.getCroppedWaypoints = function (connection, source, target) {
    source = source || connection.source;
    target = target || connection.target;

    var origWps = connection.waypoints;
    var restored = false;
    if (Array.isArray(origWps) && origWps.length > MAX_BPMN_DELEGATE_WAYPOINT_HINT) {
        connection.waypoints = decimateWaypointsToMax(origWps, MAX_BPMN_DELEGATE_WAYPOINT_HINT);
        restored = true;
    }

    try {
        var sourceDocking = this.getDockingPoint(connection, source, true),
            targetDocking = this.getDockingPoint(connection, target);

        var croppedWaypoints = connection.waypoints.slice(sourceDocking.idx + 1, targetDocking.idx);

        croppedWaypoints.unshift(dockingToPoint(sourceDocking));
        croppedWaypoints.push(dockingToPoint(targetDocking));

        return croppedWaypoints;
    } finally {
        if (restored) {
            connection.waypoints = origWps;
        }
    }
};

/**
 * Return the connection docking point on the specified shape
 *
 * @inheritDoc ConnectionDocking#getDockingPoint
 */
CroppingConnectionDocking.prototype.getDockingPoint = function (connection, shape, dockStart) {
    var waypoints = connection.waypoints,
        dockingIdx,
        dockingPoint,
        croppedPoint;

    dockingIdx = dockStart ? 0 : waypoints.length - 1;
    dockingPoint = waypoints[dockingIdx];

    croppedPoint = this._getIntersection(shape, connection, dockStart);

    return {
        point: dockingPoint,
        actual: croppedPoint || dockingPoint,
        idx: dockingIdx
    };
};

// helpers //////////////////////

CroppingConnectionDocking.prototype._getIntersection = function (shape, connection, takeFirst) {
    var shapePath = this._getShapePath(shape),
        connectionPath = this._getConnectionPath(connection);

    return getElementLineIntersection(shapePath, connectionPath, takeFirst);
};

CroppingConnectionDocking.prototype._getConnectionPath = function (connection) {
    return this._graphicsFactory.getConnectionPath(connection);
};

CroppingConnectionDocking.prototype._getShapePath = function (shape) {
    return this._graphicsFactory.getShapePath(shape);
};

CroppingConnectionDocking.prototype._getGfx = function (element) {
    return this._elementRegistry.getGraphics(element);
};
