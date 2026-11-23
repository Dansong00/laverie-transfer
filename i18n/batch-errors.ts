export const batchErrors = {
  BATCH_INVALID_ORDER_NUMBER: { en: "Invalid order number.", es: "Número de pedido no válido." },
  BATCH_SINGLE_STORE_REQUIRED: {
    en: "Choose orders from one store.",
    es: "Elige pedidos de una sola tienda.",
  },
  BATCH_INVALID_REMOVALS: {
    en: "Invalid removals.",
    es: "La lista de pedidos que quieres quitar no es válida.",
  },
  BATCH_REMOVAL_NOTE_REQUIRED: {
    en: "A note is required for each removed order.",
    es: "Escribe una nota para cada pedido que quites.",
  },
  BATCH_INVALID_OPERATION_ID: {
    en: "Invalid operation ID.",
    es: "El identificador de la operación no es válido.",
  },
  BATCH_STORE_REQUIRED: { en: "Choose a store.", es: "Elige una tienda." },
  BATCH_DUPLICATE_ADDITION: {
    en: "Select each order only once.",
    es: "Selecciona cada pedido una sola vez.",
  },
  BATCH_INVALID_BATCH_OR_VERSION: {
    en: "Invalid batch or version.",
    es: "El lote o la versión no son válidos.",
  },
  BATCH_CORRECTION_REASON_REQUIRED: {
    en: "Enter a reason for the correction.",
    es: "Indica el motivo de la corrección.",
  },
  BATCH_CORRECTION_REASON_TOO_LONG: {
    en: "Use at most {limit} characters for the correction reason.",
    es: "El motivo de la corrección puede tener hasta {limit} caracteres.",
  },
  BATCH_INVALID_CORRECTION_SELECTION: {
    en: "Invalid selection for a phase correction.",
    es: "La selección no es válida para corregir el estado.",
  },
  BATCH_WHOLE_TRAVEL_CORRECTION_REQUIRED: {
    en: "Travel corrections apply to the whole batch.",
    es: "Las correcciones del traslado se aplican a todo el lote.",
  },
  BATCH_RECEIVING_STORE_REQUIRED: {
    en: "Select the receiving store.",
    es: "Selecciona la tienda que recibe el lote.",
  },
  BATCH_ORIGIN_ORDER_REQUIRED: {
    en: "Select one order from this batch’s origin.",
    es: "Selecciona un pedido de la tienda de origen del lote.",
  },
  BATCH_MISSING_ORDER_REQUIRED: {
    en: "Select at least one order that did not travel. Corrections can only remove orders.",
    es: "Selecciona al menos un pedido que no se trasladó. La corrección solo permite quitar pedidos.",
  },
  BATCH_ORIGIN_ORDERS_REQUIRED: {
    en: "Select orders from this batch’s origin.",
    es: "Selecciona pedidos de la tienda de origen del lote.",
  },
  BATCH_MISSING_ORDER_REASON_REQUIRED: {
    en: "Enter a reason for each order that did not travel.",
    es: "Indica el motivo por el que no se trasladó cada pedido.",
  },
  BATCH_DUPLICATE_ORDER: {
    en: "Select each order once.",
    es: "Selecciona cada pedido una sola vez.",
  },
  BATCH_MEMBERSHIP_CHANGE_FORBIDDEN: {
    en: "This action cannot change batch membership.",
    es: "Esta acción no permite añadir ni quitar pedidos del lote.",
  },
  BATCH_WHOLE_RECEIPT_REQUIRED: {
    en: "Receive applies to the whole batch.",
    es: "La recepción se aplica a todo el lote.",
  },
  BATCH_ORDER_SELECTION_REQUIRED: {
    en: "Select at least one order.",
    es: "Selecciona al menos un pedido.",
  },
  BATCH_HOLDING_STORE_REQUIRED: {
    en: "Select the store holding the batch.",
    es: "Selecciona la tienda donde está el lote.",
  },
  BATCH_WHOLE_ACTION_REQUIRED: {
    en: "This action applies to the whole batch.",
    es: "Esta acción se aplica a todo el lote.",
  },
  BATCH_UNKNOWN_TRANSFER_ACTION: {
    en: "Unknown transfer action.",
    es: "La acción de traslado no se reconoce.",
  },
  BATCH_WHOLE_SEND_REQUIRED: {
    en: "Send applies to the whole batch.",
    es: "El envío se aplica a todo el lote.",
  },
  BATCH_UNKNOWN_ACTION: { en: "Unknown batch action.", es: "La acción del lote no se reconoce." },
  BATCH_INVALID_CHANGE_SELECTION: {
    en: "Choose a change and select each order only once.",
    es: "Elige un cambio y selecciona cada pedido una sola vez.",
  },
  BATCH_ORDERS_INELIGIBLE: {
    en: "Orders no longer eligible: {orders}",
    es: "Estos pedidos ya no son elegibles: {orders}",
  },
  BATCH_ORDER_NOT_IN_BATCH: {
    en: "Order is no longer in this batch: {orderNumber}",
    es: "Este pedido ya no está en el lote: {orderNumber}",
  },
  BATCH_EMPTY_SEND: {
    en: "Add an order before marking this batch sent.",
    es: "Añade un pedido antes de marcar el lote como enviado.",
  },
  BATCH_ORDERS_CANNOT_SEND: {
    en: "Orders cannot be sent: {orders}",
    es: "No se pueden enviar estos pedidos: {orders}",
  },
  BATCH_NOT_FOUND: { en: "Batch not found.", es: "No se encontró el lote." },
  BATCH_VERSION_CONFLICT: {
    en: "This batch changed, refresh.",
    es: "El lote cambió. Actualiza la página.",
  },
  BATCH_CANCELLED: { en: "This batch was cancelled.", es: "Se canceló este lote." },
  BATCH_UNSENT_REQUIRED: {
    en: "Only unsent batches can be changed.",
    es: "Solo se pueden modificar los lotes que aún no se han enviado.",
  },
  BATCH_SIGN_IN_REQUIRED: { en: "Sign in required.", es: "Inicia sesión para continuar." },
  BATCH_OPERATION_CONFLICT: {
    en: "This operation ID is already in use.",
    es: "Este identificador de operación ya está en uso.",
  },
  BATCH_ADMIN_REQUIRED: {
    en: "Admin access required.",
    es: "Se necesita acceso de administrador.",
  },
  BATCH_STAFF_REQUIRED: { en: "Staff access required.", es: "Se necesita acceso de personal." },
  BATCH_SELECTED_ORDER_REMOVED: {
    en: "This order is no longer in the batch.",
    es: "Este pedido ya no está en el lote.",
  },
  BATCH_MIXED_TRAVEL_PHASES: {
    en: "All remaining orders must be active and in the same travel phase.",
    es: "Todos los pedidos restantes deben estar activos y en la misma etapa del traslado.",
  },
  BATCH_ORDER_STEP_BACK_UNAVAILABLE: {
    en: "Only processing or ready orders can step back.",
    es: "Solo se puede retroceder un pedido en proceso o listo para devolver.",
  },
  BATCH_TRAVEL_STEP_BACK_UNAVAILABLE: {
    en: "Only sent or received batches can step back.",
    es: "Solo se puede retroceder un lote enviado o recibido.",
  },
  BATCH_HANDOFF_NOT_FOUND: {
    en: "The original handoff could not be found.",
    es: "No se encontró la entrega original.",
  },
  BATCH_RECEIPT_NOT_PENDING: {
    en: "This batch is not awaiting receipt.",
    es: "Este lote no está pendiente de recepción.",
  },
  BATCH_ORDERS_CANNOT_RECEIVE: {
    en: "Orders cannot move from sent: {orders}",
    es: "Estos pedidos no pueden pasar de enviados a recibidos: {orders}",
  },
  BATCH_ORDERS_CANNOT_START_PROCESSING: {
    en: "Orders cannot move from received: {orders}",
    es: "Estos pedidos no pueden pasar de recibidos a en proceso: {orders}",
  },
  BATCH_ORDERS_CANNOT_MARK_READY: {
    en: "Orders cannot move from processing: {orders}",
    es: "Estos pedidos no pueden pasar de en proceso a listos para devolver: {orders}",
  },
  BATCH_RETURN_ORIGIN_REQUIRED: {
    en: "Acknowledge the return at the origin store.",
    es: "Confirma la recepción de la devolución en la tienda de origen.",
  },
  BATCH_RETURN_SENDER_REQUIRED: {
    en: "Select the store sending the return.",
    es: "Selecciona la tienda que envía la devolución.",
  },
  BATCH_CONTENTS_CONFIRMATION_REQUIRED: {
    en: "Contents changed, confirm before return.",
    es: "El contenido cambió. Confírmalo antes de la devolución.",
  },
  BATCH_RETURN_NOT_SENT: {
    en: "Send the whole batch back before acknowledging its return.",
    es: "Envía todo el lote de vuelta antes de confirmar la recepción de la devolución.",
  },
  BATCH_ORDERS_NOT_READY_FOR_RETURN: {
    en: "All remaining orders must be ready for return.",
    es: "Todos los pedidos restantes deben estar listos para devolver.",
  },
  BATCH_OUTBOUND_REQUIRED: {
    en: "This action requires an outbound batch.",
    es: "Esta acción requiere un lote en el traslado de ida.",
  },
  BATCH_DEPARTURE_NOT_FOUND: {
    en: "No departure recorded for order {orderNumber}",
    es: "No se registró la salida del pedido {orderNumber}",
  },
  BATCH_WRONG_HOLDING_STORE: {
    en: "Select the store holding this batch.",
    es: "Selecciona la tienda donde está este lote.",
  },
  BATCH_RECEIPT_REQUIRED: {
    en: "Receive the batch before confirming its contents.",
    es: "Registra la recepción del lote antes de confirmar su contenido.",
  },
  BATCH_NO_CONTENTS_CHANGES: {
    en: "There are no changed contents to confirm.",
    es: "No hay cambios de contenido que confirmar.",
  },
  BATCH_INVALID_BOARD_SECTIONS: {
    en: "Choose valid board sections.",
    es: "Elige secciones válidas del tablero.",
  },
  BATCH_UNSUPPORTED_LANGUAGE: {
    en: "Choose a supported language.",
    es: "Elige uno de los idiomas disponibles.",
  },
  BATCH_SAME_ORIGIN_REQUIRED: {
    en: "Same-origin request required.",
    es: "La solicitud debe enviarse desde este sitio.",
  },
  BATCH_JSON_REQUIRED: {
    en: "Send a JSON batch change.",
    es: "Envía el cambio del lote en formato JSON.",
  },
  BATCH_INVALID_JSON: { en: "Invalid JSON.", es: "El formato JSON no es válido." },
  BATCH_UNAVAILABLE: {
    en: "Batch planning is unavailable.",
    es: "La planificación de lotes no está disponible.",
  },
} satisfies Record<string, { en: string; es: string }>;

export type BatchErrorCode = keyof typeof batchErrors;
