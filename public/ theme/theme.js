(function(){

const STORAGE="LB_THEME";
const BUTTON_POSITION="LB_THEME_BUTTON_POSITION";


/*==============================
   Cargar tema guardado
==============================*/

let theme=localStorage.getItem(STORAGE);

if(!theme){

    theme="dark";

}

document.documentElement.setAttribute("data-theme",theme);



/*==============================
   Crear botón automáticamente
==============================*/

const button=document.createElement("button");

button.id="themeToggle";

button.innerHTML=theme==="dark" ? "☀️" : "🌙";

document.body.appendChild(button);



/*==============================
   Cargar posición guardada
==============================*/

const savedPosition=localStorage.getItem(BUTTON_POSITION);

if(savedPosition){

    const position=JSON.parse(savedPosition);

    button.style.left=position.x+"px";

    button.style.top=position.y+"px";

}



/*==============================
      Cambiar tema
==============================*/

button.onclick=function(e){

    // Evita cambiar tema mientras se arrastra
    if(button.dataset.dragging==="true"){

        button.dataset.dragging="false";

        return;

    }


    theme=document.documentElement.getAttribute("data-theme");


    if(theme==="dark"){

        theme="light";

        button.innerHTML="🌙";


    }else{


        theme="dark";

        button.innerHTML="☀️";


    }


    document.documentElement.setAttribute(
        "data-theme",
        theme
    );


    localStorage.setItem(
        STORAGE,
        theme
    );


};




/*================================
   BOTÓN MOVIBLE MOUSE + TOUCH
================================*/


let dragging=false;

let startX=0;

let startY=0;

let startLeft=0;

let startTop=0;



function startMove(x,y){


    dragging=true;

    button.dataset.dragging="true";


    const rect=button.getBoundingClientRect();


    startX=x;

    startY=y;


    startLeft=rect.left;

    startTop=rect.top;


}



function moveButton(x,y){


    if(!dragging)return;


    let newX=startLeft+(x-startX);

    let newY=startTop+(y-startY);



    // Limites de pantalla

    const maxX=window.innerWidth-button.offsetWidth;

    const maxY=window.innerHeight-button.offsetHeight;



    if(newX<0)newX=0;

    if(newY<0)newY=0;


    if(newX>maxX)newX=maxX;

    if(newY>maxY)newY=maxY;



    button.style.left=newX+"px";

    button.style.top=newY+"px";

    button.style.right="auto";

    button.style.bottom="auto";


}



function endMove(){


    if(!dragging)return;


    dragging=false;


    localStorage.setItem(

        BUTTON_POSITION,

        JSON.stringify({

            x:button.offsetLeft,

            y:button.offsetTop

        })

    );


}



/* Mouse */

button.addEventListener(
"mousedown",
function(e){

    startMove(
        e.clientX,
        e.clientY
    );

});



document.addEventListener(
"mousemove",
function(e){

    moveButton(
        e.clientX,
        e.clientY
    );

});



document.addEventListener(
"mouseup",
endMove
);





/* Touch celular */

button.addEventListener(
"touchstart",
function(e){

    const touch=e.touches[0];


    startMove(

        touch.clientX,

        touch.clientY

    );

});



document.addEventListener(
"touchmove",
function(e){


    const touch=e.touches[0];


    moveButton(

        touch.clientX,

        touch.clientY

    );


});



document.addEventListener(
"touchend",
endMove
);



})();
