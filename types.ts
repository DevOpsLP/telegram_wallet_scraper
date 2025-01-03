
export interface OrderResponse {
    orderId: number;
    symbol: string;
    status: string;
    clientOrderId: string;
    price: string;
    avgPrice: string;
    origQty: string;
    executedQty: string;
    cumQty: string;
    cumQuote: string;
    timeInForce: string;
    type: string;
    reduceOnly: boolean;
    closePosition: boolean;
    side: string;
    positionSide: string;
    stopPrice: string;
    workingType: string;
    priceProtect: boolean;
    origType: string;
    priceMatch: string;
    selfTradePreventionMode: string;
    goodTillDate: number;
    updateTime: number;
  }

  export interface TradeSignal {
    pair: string;
    direction: string;
    marginType: string;
    leverage: number;
    entry: number[];
    targets: number[];
    stopLoss: number | string;
  }